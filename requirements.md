# 📌 Requirements

## 1. Guest Limits
- Non-authenticated users can send only **2 messages**.
- On sending the 3rd message, show:
  - "Please log in or create an account"
- Image upload limit for guests:
  - **5 images per day**
- When the limit is exceeded, show:
  - "You have reached the daily image upload limit"

---

## 2. Study Mode
- The message "Welcome to Study Mode" appears **only when starting a new chat**.
- It should NOT appear when:
  - Opening an existing chat
  - Refreshing the page

---

## 3. Chat Persistence
- On page refresh:
  - The current chat remains unchanged
  - No new chat is created

---

## 4. Share Chat
- When a shared chat link is opened from another account:
  - The full chat content must be visible

---

## 5. Remove Download Feature
- Completely remove the "Download App" feature from the website

---

## 6. Chat Title
- The chat title must NOT be based on the last user message
- If the chat starts with an image, the title must NOT be empty
- The title should be based on the topic/category (e.g., Math, General, etc.)

---

## 7. Timer UI
- The timer must always be visible to the user
- Must work on both:
  - Mobile
  - Desktop
