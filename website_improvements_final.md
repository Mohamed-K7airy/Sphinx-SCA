# Website Improvement Tasks

## 1. Dashboard UI Issues

-   The font used in the dashboard is not visually appealing.
-   The current font color appears too faint and reduces readability.
-   Improve typography by selecting a modern, clean font.
-   Increase contrast between text and background to enhance visibility.

## 2. Image Processing in Study Agent

-   The image reading feature is currently not working in the Study
    Agent.

### 2.1 Required Enhancement

-   Enable image processing in Study Mode such that:
    -   Allow students to upload an image containing a math equation.
    -   The model should extract the equation from the image (OCR
        functionality).
    -   Automatically convert the extracted content into a solvable math
        problem.
    -   Place the student in an interactive "teacher-like" session
        where:
        -   The student can request hints.
        -   The student can request a full solution.
        -   The student can end the session at any time.

## 3. Timer UI in Study Mode

-   Improve the visual design of the timer in Study Mode.
-   Make it more modern and engaging.
-   Enhance clarity and readability (size, contrast, placement).
-   Consider adding subtle animations or progress indicators for better
    user experience.

## 4. Login Redirect Behavior

-   After a user logs in, they should be redirected to the Home Page
    instead of the Dashboard.
-   Ensure this behavior is consistent across all authentication flows.

## 5. Streaming Response UX Improvement

-   Improve the appearance of streaming text while the model is
    generating responses.
-   Currently, the text appears unformatted during streaming and is
    corrected only after completion.
-   Required behavior:
    -   Buffer and format the response before displaying it to the user.
    -   Ensure clean, well-structured output from the start.
    -   Avoid showing broken or partially formatted text during
        generation.
    -   Provide a smoother and more professional user experience.
