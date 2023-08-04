chrome.storage.local.get('result', function(data) {
    document.getElementById('result').textContent = data.result;
});
