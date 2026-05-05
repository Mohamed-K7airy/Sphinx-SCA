import json
import re
import os
from datetime import datetime
from groq import AsyncGroq
from .generate_embeddings import generate_embeddings
from .vectordb import (
    EmbeddedMemory,
    RetrievedMemory,
    delete_records,
    fetch_all_user_records,
    insert_memories,
    search_memories,
)

async def update_memories_agent(
    user_id: str, messages: list[dict], existing_memories: list[RetrievedMemory]
):
    groq_api_key = os.getenv("GROQ_API_KEY")
    if not groq_api_key:
        print("Error: No GROQ_API_KEY found.")
        return "Error"

    client = AsyncGroq(api_key=groq_api_key)

    # Format existing memories to pass to the agent
    mem_info = "\n".join([
        f"ID {idx}: {m.memory_text} (Categories: {', '.join(m.categories)})" 
        for idx, m in enumerate(existing_memories)
    ])

    # Pass the last 5 messages to understand context
    conv = "\n".join([f"{msg['role']}: {msg['content']}" for msg in messages[-5:]])

    prompt = f"""
You are a memory manager. Based on the conversation summary, decide how to update the long-term database to help the AI remember important context about the user's learning progress, past answers, and traits.

Existing memories:
{mem_info if mem_info else "None"}

Conversation:
{conv}

Actions meaning:
- ADD: add new memories if the user introduced new concepts, preferences, or mistakes.
- UPDATE: update an existing memory with richer or corrected information.
- DELETE: remove memories that are obsolete.

Respond ONLY with a JSON array of actions. Actions can be:
- {{"action": "add", "memory_text": "text format", "categories": ["category"]}}
- {{"action": "update", "memory_id": 0, "memory_text": "new text", "categories": ["category"]}}
- {{"action": "delete", "memory_id": 0}}

If no changes are needed, return an empty array [].
Respond ONLY in valid JSON. No markdown backticks, no explanations.
"""
    try:
        gemini_api_key = os.getenv("GEMINI_API_KEY")
        response = None
        
        if gemini_api_key:
            try:
                from openai import AsyncOpenAI
                gemini_client = AsyncOpenAI(
                    api_key=gemini_api_key,
                    base_url="https://generativelanguage.googleapis.com/v1beta/openai/"
                )
                response = await gemini_client.chat.completions.create(
                    model="gemini-2.5-flash",
                    messages=[{"role": "user", "content": prompt}],
                    temperature=0.0
                )
            except ImportError as e:
                print(f"Error executing memory agent: {e}")
                response = None
            except Exception as e:
                print(f"Gemini API error during memory update: {e}")
                response = None

        if response is None:
            response = await client.chat.completions.create(
                model="llama-3.3-70b-versatile",
                messages=[{"role": "user", "content": prompt}],
                temperature=0.0
            )
        #بيشيل الـ ``` لو الرد جاي في شكل كود 
        reply = response.choices[0].message.content.strip()
        reply = re.sub(r'^```(?:json)?\s*', '', reply)
        reply = re.sub(r'\s*```\s*$', '', reply)
        
        actions = json.loads(reply) #{ "action": "add" } -> {'action': 'add'}
        
        if not actions:
            return "No action done"
            
        added_count = 0
        updated_count = 0
        deleted_count = 0
            
        for action in actions:
            act = action.get("action")
            if act == "add":
                text = action.get("memory_text") #text = "I love FC 25"
                cats = action.get("categories", []) #cats = ["user_interests"]
                if text:
                    emb = await generate_embeddings([text]) #[0.1, 0.2, 0.3, ...]
                    if not emb:
                        print("⚠️ Skipping ADD: embedding generation failed.")
                        continue
                    # without [0]:
                    #     generate_embedding("hello")
                    #     generate_embedding("world")
                    #     generate_embedding("ai")
                    # with [0]:
                    #     generate_embeddings(["hello", "world", "ai"])
                    await insert_memories([
                        EmbeddedMemory(
                            user_id=user_id,
                            memory_text=text,
                            categories=cats,
                            date=datetime.now().strftime("%Y-%m-%d %H:%M"),
                            embedding=emb[0]
                        )
                    ])
                    added_count += 1
            elif act == "update":
                m_id = action.get("memory_id") 
                text = action.get("memory_text")#text = "I love FC 26"
                cats = action.get("categories", []) #cats = ["user_interests"]
                if m_id is not None and 0 <= m_id < len(existing_memories) and text:
                    point_id = existing_memories[m_id].point_id
                    await delete_records([point_id])#بيحذف القديم عشان يضيف الجديد بدلوا
                    emb = await generate_embeddings([text])
                    if not emb:
                        print("⚠️ Skipping UPDATE: embedding generation failed.")
                        continue
                    await insert_memories([
                        EmbeddedMemory(
                            user_id=user_id,
                            memory_text=text,
                            categories=cats,
                            date=datetime.now().strftime("%Y-%m-%d %H:%M"),
                            embedding=emb[0]
                        
                        )
                    ])
                    updated_count += 1
            elif act == "delete":
                m_id = action.get("memory_id")
                if m_id is not None and 0 <= m_id < len(existing_memories):
                    point_id = existing_memories[m_id].point_id
                    await delete_records([point_id])
                    deleted_count += 1
                    
        return f"Added: {added_count}, Updated: {updated_count}, Deleted: {deleted_count}"
    except Exception as e:
        print(f"Error executing memory agent: {e}")
        return "Error"

#خد آخر كلام المستخدم حوّله لأرقام دور على ذكريات مشابهة خلّي AI يقرر نعمل إيه في الذاكرة
async def update_memories(user_id: str, messages: list[dict]):
    try:
        user_messages = [x["content"] for x in messages if x["role"] == "user"]#بيشوف طلبات المستخدم فقط
        if not user_messages:
            return "No user messages found"
        latest_user_message = user_messages[-1]#بيركز على أحدث طلب من المستخدم فقط
        
        emb = await generate_embeddings([latest_user_message])#حوّل الكلام لرقم
        if not emb:
            print("⚠️ Embedding generation failed — skipping memory update.")
            return "Embedding failed"
        embedding = emb[0]  #خد الرقم

        retrieved_memories = await search_memories(search_vector=embedding, user_id=user_id)#دور على ذكريات مشابهة
         #خلّي AI يقرر نعمل إيه في الذاكرة
        response = await update_memories_agent(
            user_id=user_id, existing_memories=retrieved_memories, messages=messages
        )
        return response
    except Exception as e:
        print(f"Error updating memory in main wrapper: {e}")
        return "Error updating memory"
