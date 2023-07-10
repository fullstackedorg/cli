export default `
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>FullStacked Sharing</title>
    <style>
        *{
            box-sizing: border-box;
            -webkit-font-smoothing: antialiased;
            -moz-osx-font-smoothing: grayscale;
        }
        html, body{
            background-color: #1e293c;
            height: 100%;
            width: 100%;
            margin: 0;
            padding: 0;
            font-family: sans-serif;
        }
        body {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            color: white;
        }
        img {
            height: 70px;
        }
        form {
            display: flex;
            align-items: center;
            border-radius: 5px;
            box-shadow: 0 0 15px 2px #a5afc240;
            background-color: #2b3952;
            transition: 0.2s background-color;
        }
        form:hover {
            background-color: #374662;
        }
        input, button {
            background-color: transparent;
            color: #e9edf4;
            border: 1px solid #777f8c;
            font-size: large;
            margin: 0;
        }
        button {
            height: 100%;
            border-left: 0;
            border-radius: 0 5px 5px 0;
            padding: 0 10px;
            cursor: pointer;
        }
        input {
            padding: 6px 10px;
            border-radius: 5px 0 0 5px;
            outline: 0;
        }
        svg{
            vertical-align: middle;
        }
    </style>
</head>
<body>
    <img src="https://files.cplepage.com/fullstacked/app-icon.png" />
    <h1>FullStacked Share</h1>
    <p>Enter Password</p>
    <form>
        <input type="password" />
        <button>
            <svg fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" viewBox="0 0 24 24" height="20" width="20" style="color: currentcolor;">
                <path d="M5 12h14M12 5l7 7-7 7"></path>
            </svg>
        </button>
    </form>
    <script type="module">
        document.querySelector("input").focus();

        async function submit(e){
            e.preventDefault();
            const response = await (await fetch("/", {
                method: "POST",
                body: JSON.stringify({
                    password: document.querySelector("input").value
                })
            })).text();

            if(response === "Bonjour")
                window.location.reload();
        }
        document.querySelector("form").addEventListener("submit", submit)
    </script>
</body>
</html>
`;
