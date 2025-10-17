![What Am I Drawing?](/logo.png)

# What Am I Drawing?

![License: MIT](https://img.shields.io/badge/license-MIT-green.svg) [![Contributions welcome](https://img.shields.io/badge/contributions-welcome-brightgreen.svg?style=flat)](https://github.com/fredrik-stigsson/what-am-i-drawing/issues) ![Version 1.0.0](https://img.shields.io/badge/version-1.0.0-blue)

What Am I Drawing? is the ultimate social drawing game! One player draws a secret word while everyone else races to type their guesses. Score points for being the first to guess correctly or for creating drawings that stump your friends!

---

## Installation
```bash
cd /var/www (if you want the service to work out of the box)
git clone https://github.com/fredrik-stigsson/what-am-i-drawing.git
cd what-am-i-drawing
npm install --omit=dev
```

---

## Enable service on production server
```bash
cp /var/www/what-am-i-drawing/what-am-i-drawing.service /etc/systemd/system/what-am-i-drawing.service
systemctl daemon-reload
systemctl enable what-am-i-drawing
systemctl start what-am-i-drawing
```