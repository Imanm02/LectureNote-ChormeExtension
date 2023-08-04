chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
    if (request.message === "getSelection") {
        var selection = window.getSelection().toString();
        sendResponse(selection);
    }
});
