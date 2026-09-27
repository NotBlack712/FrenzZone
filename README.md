# Local Social ( Open Source for Learning, Not business purpose )

A simple, modern social chatting website that runs **entirely on your own computer**. Built with Node.js, Express, Socket.IO and SQLite — no cloud database, no external services, no internet connection required once dependencies are installed.

Features: registration/login with hashed passwords, a live home feed, image/video posts, likes, comments, public profiles, user search, and real-time updates over Socket.IO.

---

## 1. Install Node.js

You need **Node.js version 22.5 or newer** (the app uses Node's built-in `node:sqlite` module, so there's nothing to compile — no Visual Studio / build tools needed on Windows).

1. Go to https://nodejs.org
2. Download the **LTS** version for your operating system (Windows, macOS, or Linux) and run the installer.
3. Confirm it installed correctly by opening a terminal (Command Prompt, PowerShell, or Terminal) and running:
   ```
   node -v
   npm -v
   ```
   Both commands should print a version number. `node -v` should be 22.5.0 or higher.

## 2. Install the project dependencies

1. Unzip this project folder somewhere on your computer.
2. Open a terminal and navigate into the project folder:
   ```
   cd path/to/social-app
   ```
3. Install dependencies:
   ```
   npm install
   ```
   This downloads Express, Socket.IO, bcryptjs, multer and a few other small libraries into a local `node_modules/` folder. There's no native module to compile, so this should finish in a few seconds with no build-tools requirement.

## 3. How the SQLite database works

- The app uses Node's built-in [`node:sqlite`](https://nodejs.org/api/sqlite.html) module — a synchronous SQLite driver that ships with Node itself (v22.5+). No separate database server, no npm package to compile, nothing extra to install.
- You'll see an `(ExperimentalWarning: SQLite is an experimental feature...)` line in the terminal when the server starts — that's expected and harmless; it just means this particular Node API hasn't been marked fully stable yet.
- On first launch, the server automatically creates a file called `database.sqlite` in the project root and sets up all the required tables (`users`, `posts`, `likes`, `comments`) with proper foreign keys.
- All your data — accounts, posts, likes, comments — lives in that single file. Nothing is sent anywhere else.
- Uploaded images/videos are **not** stored inside the database; only their file path is. The actual files live in the `/uploads` folder (see below).

## 4. Start the server

From inside the project folder:

```
npm start
```

You should see:

```
[database] New SQLite database created at .../database.sqlite
Local Social running at http://localhost:3000
```

## 5. Access the website

Open your browser and go to:

```
http://localhost:3000
```

Register a new account (or open the site in two different browsers/incognito windows to simulate two users chatting) and start posting. Real-time updates (new posts, likes, comments) will appear instantly for anyone else currently viewing the feed — no page refresh needed.

To stop the server, go back to the terminal and press `Ctrl + C`.

## 6. Where uploaded files are stored

All uploaded images and videos are saved locally inside the `/uploads` folder in the project directory, with randomly generated filenames. The database only stores the relative path to each file (e.g. `/uploads/172839-ab12cd.jpg`), never the file's binary content.

Allowed types: **JPG, JPEG, PNG, GIF, MP4, WebM**. Max upload size: 100MB per file.

## 7. How to reset the local database

If you want to wipe all accounts, posts, likes and comments and start fresh:

1. Stop the server (`Ctrl + C`).
2. Delete `database.sqlite` (and `database.sqlite-shm` / `database.sqlite-wal` if present) from the project root.
3. Optionally, also clear out the `/uploads` folder if you want to remove old media files too.
4. Run `npm start` again — a brand new, empty database will be created automatically.

---

## Project structure

```
social-app/
├── server.js           # Express + Socket.IO entry point
├── package.json
├── database/
│   └── init.js         # SQLite schema + connection
├── middleware/
│   ├── auth.js         # session-based auth guards
│   └── upload.js       # multer config for image/video uploads
├── routes/
│   ├── auth.js         # register, login, logout, profile edit
│   ├── users.js        # search, public profiles
│   ├── posts.js        # feed, create/delete posts
│   ├── likes.js        # like/unlike toggle
│   └── comments.js     # add/list/delete comments
├── socket/
│   └── index.js        # Socket.IO connection + online-status tracking
├── public/              # static frontend (served at /)
│   ├── index.html
│   ├── css/style.css
│   └── js/{api.js, app.js}
└── uploads/              # uploaded media lives here (gitignored)
```

## Notes on security

- Passwords are hashed with bcrypt before being stored — plaintext passwords are never saved.
- Sessions use an HTTP-only cookie via `express-session`.
- Every write route (create/delete post, like, comment) checks that a session is present and, for deletes, that the requesting user actually owns the resource.
- File uploads are restricted by MIME type and size on the server side, not just in the browser.
- Basic rate limiting is applied to login/register and to the API in general to slow down abuse.
- All SQL queries use parameterized statements (no string-concatenated SQL), so there's no SQL injection surface.

This project is meant for local/personal use and learning. The session secret in `server.js` is a placeholder — change it if you ever deploy this beyond your own machine.
