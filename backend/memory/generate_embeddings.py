import asyncio
from sentence_transformers import SentenceTransformer

# We load the model lazily so it doesn't block the application startup
_model = None

def _generate_sync(strings: list[str]):
    """Generates embeddings synchronously using local model."""
    global _model
    if _model is None:
        print("⏳ Loading local embedding model (SentenceTransformer) for the first time...")
        _model = SentenceTransformer('sentence-transformers/all-MiniLM-L6-v2')
        print("✅ Local embedding model loaded!")
        
    embeddings = _model.encode(strings)
    # convert numpy array to normal python list
    return embeddings.tolist()

async def generate_embeddings(strings: list[str]):
    if not strings:
        return []
        
    # Run the CPU-bound embedding generation in a separate thread
    # so we don't block the FastAPI async loop and responses.
    embeddings = await asyncio.to_thread(_generate_sync, strings)
    
    # Ensure it's always a list of lists (handling single vs multiple strings)
    if len(embeddings) > 0 and not isinstance(embeddings[0], list):
        embeddings = [embeddings]
        
    return embeddings

if __name__ == "__main__":
    texts = [
        "Hello how are you",
        "I like Machine Learning"
    ]
    print(asyncio.run(generate_embeddings(texts)))
