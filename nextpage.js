document.addEventListener('DOMContentLoaded', (event) => {
    document.getElementById('generateBtn').addEventListener('click', function(event) {
        event.preventDefault();

        // Get the selected text
        chrome.storage.local.get('selectedText', function(data) {
            const selectedText = data.selectedText;

        // Only proceed if at least 5 characters are selected
        if (selectedText.length >= 5) {
            // Prepare the GPT-3 API request payload
            const gpt3Payload = {
                "model": "gpt-3.5-turbo",
                "messages": [
                    {
                        "role": "system",
                        "content": "You are given a text, which contains unorganized information intended to be included in a lecture note. Your task is to make a concise text out of the keywords, without including new ideas. The text should be written in a way that is easy to understand. Write one paragraph of a maximum of 150 words, along with an example, and mathematical formula if exists, for each keyword. Before each paragraph, also provide a relevant title for the paragraph in bold HTML. Insert two blank lines between the paragraphs for each of the keywords. If you provide any formula, provide it in the TeX format. Don't output any text other that the lecture note."
                    },
                    {
                        "role": "user",
                        "content": selectedText
                    }
                ]
            };

            // Prepare the fetch() options
            const requestOptions = {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': ``
                },
                body: JSON.stringify(gpt3Payload)
            };

            // Make the API request
            fetch('https://api.openai.com/v1/engines/davinci-codex/completions', requestOptions)
                .then(response => response.json())
                .then(data => {
                    // Open a new tab with the result
                    const resultText = data['choices'][0]['message']['content'];
                    const resultHTML = `<html><body><p>${resultText}</p></body></html>`;
                    const resultURL = `data:text/html,${encodeURIComponent(resultHTML)}`;
                    window.open(resultURL, '_blank');
                })
                .catch((error) => {
                    console.error('Error:', error);
                });
        }
    });
});