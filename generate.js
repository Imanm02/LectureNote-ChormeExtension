chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    fetch('https://api.openai.com/v1/engines/davinci-codex/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer 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'
        },
        body: JSON.stringify({
            prompt: `You are given a text, which contains unorganized information intended to be included in a lecture note. Your task is to make a concise text out of the keywords, without including new ideas. The text should be written in a way that is easy to understand. Write one paragraph of a maximum of 150 words, along with an example, and mathematical formula if exists, for each keyword. Before each paragraph, also provide a relevant title for the paragraph in bold HTML. Insert two blank lines between the paragraphs for each of the keywords. If you provide any formula, provide it in the TeX format. Don't output any text other that the lecture note.\n\n${request.text}`,
            max_tokens: 500
        })
    })
    .then(response => response.json())
    .then(data => {
        // Store the result in local storage
        chrome.storage.local.set({result: data.choices[0].text}, function() {
            console.log('Result saved.');

            // Open the results page in a new tab
            chrome.tabs.create({url: chrome.runtime.getURL('results.html')});
        });
    })
    .catch((error) => {
        console.error('Error:', error);
    });
});
