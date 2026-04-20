"""
╔══════════════════════════════════════════════════════════════════╗
║  ARIA — Adaptive Reasoning & Intelligence Agent                  ║
║  Stack: Groq (llama-3.3-70b) + Tavily Search (free tier)         ║
║                                                                  ║
║  Free tier limits:                                               ║
║    Groq  — generous free RPM/TPM limits                          ║
║    Tavily — 1,000 searches/month free                            ║
╚══════════════════════════════════════════════════════════════════╝
"""

import os
import json
import logging
import re
import asyncio
from dataclasses import dataclass
from typing import Optional

try:
    from pathlib import Path
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).parent / ".env")  # ← always finds .env next to this script
except ImportError:
    pass  # python-dotenv not installed; fall back to real env vars

from groq import Groq, AsyncGroq
from tavily import TavilyClient

# ─── LOGGING ────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="[ARIA] %(levelname)s — %(message)s"
)
logger = logging.getLogger("aria")


# ─── SYSTEM PROMPT ──────────────────────────────────────────────────────────
SYSTEM_PROMPT = """You are ARIA (Adaptive Reasoning & Intelligence Agent), an expert AI assistant
with real-time web search and YouTube integration.

CORE BEHAVIOR:
1. Decide intelligently whether you need external context to answer the user's question, and use the provided tools if necessary.
   - For general knowledge or math, answer directly.

2. Keep your search queries concise (2-5 words).

3. SAFETY: Never assist with harmful, illegal, or disallowed content.

RESPONSE STYLE:
- Conversational but precise. Use bullet points for lists. Bold key terms.
- Keep responses concise unless depth is requested."""

STRICT_WEB_PROMPT = """You are a STRICT retrieval agent.
You have been provided with search results below.
1. You MUST formulate your answer based ONLY on the provided search results.
2. DO NOT use your internal knowledge. DO NOT hallucinate facts or URLs.
3. If the answer is not in the search results, say "I couldn't find the exact answer in the latest search results."
4. CITE your sources at the end in this exact format:
   Sources:
   1. [Source Title](https://url.com)
5. You MUST ONLY use the URLs explicitly provided in the search context."""

STRICT_YOUTUBE_PROMPT = """You are a YouTube Video Curator.
You have been provided with YouTube search results below.
1. Your ONLY job is to list the videos returned in the exact format:
   - **[Video Title](URL)**
   - Provide a brief 1-2 sentence description based on the search context.
2. DO NOT invent, guess, or hallucinate titles, channels, or URLs.
3. If no relevant videos are found in the context, say "I couldn't find relevant videos."
4. You MUST ONLY use the exact URLs provided in the context."""

# ─── TOOL DEFINITIONS (Groq function calling format) ─────────────────────────
WEB_SEARCH_TOOL = {
    "type": "function",
    "function": {
        "name": "web_search",
        "description": "Search the internet for real-time, current, or recent information.",
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Concise search query, 2-5 words max."
                }
            },
            "required": ["query"]
        }
    }
}

YOUTUBE_SEARCH_TOOL = {
    "type": "function",
    "function": {
        "name": "youtube_search",
        "description": "Search YouTube for videos, tutorials, or visual explanations. Returns video titles and links.",
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Concise search query for YouTube, 2-5 words max."
                }
            },
            "required": ["query"]
        }
    }
}


# ─── DATA CLASSES ────────────────────────────────────────────────────────────
@dataclass
class Source:
    title: str
    url: str

    def __str__(self):
        return f"[{self.title}]({self.url})"

    def to_dict(self):
        return {"title": self.title, "url": self.url}


@dataclass
class AgentResponse:
    text: str
    sources: list
    searched_web: bool
    mode: str = "QA"
    error: Optional[str] = None

    def to_dict(self):
        return {
            "text": self.text,
            "sources": [s.to_dict() for s in self.sources],
            "searched_web": self.searched_web,
            "mode": self.mode,
            "error": self.error,
        }

    def __str__(self):
        parts = [self.text]
        if self.sources:
            parts.append("\nSources:")
            for i, src in enumerate(self.sources, 1):
                parts.append(f"  {i}. {src}")
        return "\n".join(parts)


# ─── VALIDATION LAYER ────────────────────────────────────────────────────────
class ValidationLayer:
    @staticmethod
    def validate_urls(text: str, allowed_urls: set[str]) -> str:
        """Finds markdown links and ensures their URLs exist in the allowed_urls set."""
        if not allowed_urls:
            return text
            
        pattern = re.compile(r'\[([^\]]+)\]\((https?://[^\)]+)\)')

        def normalize(u: str) -> str:
            return u.replace("https://", "").replace("http://", "").replace("www.", "").rstrip("/")

        norm_allowed = {normalize(u) for u in allowed_urls}

        def repl(match):
            title = match.group(1)
            url = match.group(2)
            n_url = normalize(url)
            
            is_valid = any(n_url.startswith(a) or a.startswith(n_url) for a in norm_allowed)
            if is_valid:
                return match.group(0)
            else:
                return f"**{title}** [REDACTED: Unverified Link]"

        return pattern.sub(repl, text)


# ─── RESPONSE PARSER ────────────────────────────────────────────────────────
class ResponseParser:
    SOURCE_PATTERN = re.compile(r'\[([^\]]+)\]\((https?://[^\)]+)\)')

    @classmethod
    def parse(cls, text: str, searched: bool) -> AgentResponse:
        # Split off Sources section
        parts = re.split(
            r'\n\*?\*?Sources?\*?\*?:?\s*\n',
            text, maxsplit=1, flags=re.IGNORECASE
        )
        main_text = parts[0].strip()

        # Extract all [Title](URL) citations
        seen: set = set()
        sources = []
        for m in cls.SOURCE_PATTERN.finditer(text):
            if m.group(2) not in seen:
                seen.add(m.group(2))
                sources.append(Source(title=m.group(1), url=m.group(2)))

        # Clean inline links from display text
        clean = cls.SOURCE_PATTERN.sub(r'**\1**', main_text)

        return AgentResponse(text=clean, sources=sources, searched_web=searched)


# ─── ARIA AGENT ──────────────────────────────────────────────────────────────
class ARIAAgent:
    """
    ARIA Agent — Groq LLM + Tavily web search, async streaming supported.
    """

    def __init__(
        self,
        groq_api_key: Optional[str] = None,
        tavily_api_key: Optional[str] = None,
        model: str = "llama-3.3-70b-versatile",
        max_tokens: int = 1024,
    ):
        groq_key    = groq_api_key   or os.getenv("ARIA_GROQ_API_KEY") or os.getenv("GROQ_API_KEY")
        tavily_key  = tavily_api_key or os.getenv("TAVILY_API_KEY")

        if not groq_key:
            raise ValueError("No Groq API key.")
        if not tavily_key:
            raise ValueError("No Tavily API key.")

        self.groq       = Groq(api_key=groq_key)
        self.async_groq = AsyncGroq(api_key=groq_key)
        self.tavily     = TavilyClient(api_key=tavily_key)
        self.model      = model
        self.max_tokens = max_tokens

        logger.info(
            f"ARIA initialized | model={model} | web_search=Tavily"
        )

    def _run_search(self, query: str, include_domains: Optional[list[str]] = None) -> tuple[str, set[str]]:
        """Run Tavily search and format results, returning (formatted_str, valid_urls_set)."""
        try:
            kwargs = {
                "query": query,
                "search_depth": "basic",
                "max_results": 5,
                "include_answer": True,
            }
            if include_domains:
                kwargs["include_domains"] = include_domains

            result = self.tavily.search(**kwargs)

            parts = []
            urls = set()

            if result.get("answer"):
                parts.append(f"Quick answer: {result['answer']}\n")

            for i, item in enumerate(result.get("results", [])[:5], 1):
                title   = item.get("title", "No title")
                url     = item.get("url", "")
                content = item.get("content", "")[:400]
                parts.append(f"{i}. [{title}]({url})\n   {content}")
                if url:
                    urls.add(url)

            return ("\n\n".join(parts) if parts else "No results found.", urls)

        except Exception as e:
            logger.error(f"Tavily error: {e}")
            return (f"Search failed: {e}. Please answer from your training knowledge.", set())

    async def stream_search(self, messages: list):
        """
        Tool-use router and strict execution loop with streaming support.
        Yields chunks of text, and finally yields a JSON string containing the sources if any.
        """
        system_messages = [{"role": "system", "content": SYSTEM_PROMPT}] + messages
        
        # Step 1: Routing
        try:
            response = await self.async_groq.chat.completions.create(
                model=self.model,
                max_tokens=self.max_tokens,
                tools=[WEB_SEARCH_TOOL, YOUTUBE_SEARCH_TOOL],
                tool_choice="auto",
                messages=system_messages,
            )

            choice  = response.choices[0]
            message = choice.message

            # Step 2: Pure QA (Mode A)
            if choice.finish_reason == "stop" or not message.tool_calls:
                final_text = message.content or ""
                # Provide it quickly
                yield final_text
                parsed = ResponseParser.parse(final_text, False)
                parsed.mode = "QA"
                yield "```json\n__SEARCH_SOURCES__\n" + json.dumps(parsed.to_dict()) + "\n```"
                return

            tc = message.tool_calls[0]
            tool_name = tc.function.name
            args = json.loads(tc.function.arguments)
            query = args.get("query", "")
            
        except Exception as e:
            err_str = str(e)
            if "tool_use_failed" in err_str:
                logger.warning("Caught Groq tool_use_failed bug, recovering raw function...")
                m = re.search(r'<function=(\w+)(.*?)(?:</function>|>)', err_str)
                if m:
                    tool_name = m.group(1)
                    raw_args = m.group(2)
                    raw_args = raw_args.strip(',') 
                    try:
                        args = json.loads(raw_args)
                        query = args.get("query", "")
                    except:
                        q_match = re.search(r'"query"\s*:\s*"([^"]+)"', raw_args)
                        query = q_match.group(1) if q_match else "latest news"
                else:
                    yield f"Something went wrong: {e}"
                    return
            else:
                yield f"Something went wrong: {e}"
                return

        # Notify user subtly that a search is happening
        pill_html = '<div class="agent-status-pill is-active" style="margin-bottom: 12px;"><div class="agent-status-dot"></div><span class="agent-status-text">Searching {source} for: <strong>{query}</strong></span></div>\n\n'
        if tool_name == "youtube_search":
            yield pill_html.format(source="YouTube", query=query)
        else:
            yield pill_html.format(source="the web", query=query)

        # Allow yield to flush
        await asyncio.sleep(0.1)

        # Step 3: Handle Search (Mode B or C)
        strict_prompt = STRICT_WEB_PROMPT
        mode_str = "WEB_SEARCH"
        
        if tool_name == "youtube_search":
            logger.info(f"YouTube search: '{query}'")
            # Offload synchronous Tavily call to thread
            results_str, valid_urls = await asyncio.to_thread(self._run_search, query, ["youtube.com"])
            search_context = f"YouTube Search Results for '{query}':\n{results_str}"
            strict_prompt = STRICT_YOUTUBE_PROMPT
            mode_str = "YOUTUBE_SEARCH"
        else:
            logger.info(f"Web search: '{query}'")
            results_str, valid_urls = await asyncio.to_thread(self._run_search, query)
            search_context = f"Web Search Results for '{query}':\n{results_str}"
            
        # Step 4: Strict Generation
        user_msg = messages[-1]["content"] if messages else ""
        strict_messages = [
            {"role": "system", "content": strict_prompt},
            {"role": "user", "content": f"Original Question: {user_msg}\n\n{search_context}"}
        ]
        
        yield "<!-- SEARCH_DONE -->\n\n"
        
        try:
            stream = await self.async_groq.chat.completions.create(
                model=self.model,
                max_tokens=self.max_tokens,
                messages=strict_messages,
                stream=True
            )
            
            full_text = ""
            async for chunk in stream:
                if chunk.choices:
                    delta_content = getattr(chunk.choices[0].delta, "content", None)
                    if delta_content:
                        full_text += delta_content
                        yield delta_content

            # Step 5: Validation Layer
            validated_text = ValidationLayer.validate_urls(full_text, valid_urls)
            
            # Since we streamed full_text unvalidated, we just emit the sources at the end
            # The UI can replace inline links or just show the source blocks.
            parsed = ResponseParser.parse(validated_text, True)
            parsed.mode = mode_str
            yield "\n```json\n__SEARCH_SOURCES__\n" + json.dumps(parsed.to_dict()) + "\n```"

        except Exception as e:
            yield f"\nSearch failed: {e}"
