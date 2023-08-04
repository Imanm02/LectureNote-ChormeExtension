document.addEventListener('mouseup', function() {
    var selectedText = window.getSelection().toString().trim();
    if (selectedText.length > 0) {
        chrome.storage.local.set({'selectedText': selectedText});
    }
});