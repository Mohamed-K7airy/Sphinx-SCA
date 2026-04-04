import sys
import os
# Ensure we can import from the current directory
sys.path.append(os.getcwd())

from backend.llm_manager import LLMManager

def test():
    print("Initializing LLMManager...")
    llm = LLMManager()
    messages = [{"role": "user", "content": "Say hello"}]
    print("Starting stream...")
    try:
        for chunk in llm.stream_chat(messages):
            print(f"Received chunk: {chunk}")
    except Exception as e:
        print(f"Exception during stream: {e}")

if __name__ == "__main__":
    test()
