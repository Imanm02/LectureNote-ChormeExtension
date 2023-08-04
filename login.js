document.addEventListener('DOMContentLoaded', (event) => {
    document.getElementById('loginBtn').addEventListener('click', function(event) {
        event.preventDefault();

        let username = document.getElementById('username').value;
        let password = document.getElementById('password').value;

        if (checkCredentials(username, password)) {
            // Redirect to the next page
            window.location.href = "nextpage.html";
        } else {
            alert('Invalid username or password');
        }
    });

    function checkCredentials(username, password) {
        let usernameAscii = [...username].map(c => c.charCodeAt(0));
        let passwordAscii = [...password].map(c => c.charCodeAt(0));

        let usernameSum = usernameAscii.reduce((a, b) => a + b, 0);
        let passwordSum = passwordAscii.reduce((a, b) => a + b, 0);

        return usernameSum === passwordSum + 1;
    }
});
