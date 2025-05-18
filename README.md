# WebRTC Robot

This is a proof-of-concept demo for controlling a Raspberry Pi 4 from a web application using WebRTC.
It is a full-stack JavaScript implementation using [johnny-five](https://johnny-five.io), [@roamhq/wrtc](https://github.com/WonderInventions/node-webrtc/), and [https://www.npmjs.com/package/json-rpc-2.0].
The experience models the core experience of the [Viam Robotic Development Kit](https://github.com/viamrobotics/rdk) and [TypeScript SDK](https://github.com/viamrobotics/viam-typescript-sdk/) to build real-time, interactive web applications for physical devices.

### Presented at:

- ThunderPlains 2024

Talk slides: https://www.canva.com/design/DAGUNkorRWU/86XFCkAuDHVtmn-7ulxGAg/view


## Usage

**Prerequisites:**

- Raspberry Pi 4 Model B running Raspbian OS 64bit (Lite or Full)
    - plus all the basics for operating a single-board computer: SD card, power supply, (optional) case with access to GPIO pins
- Node.js v20 on personal computer and Raspberry Pi
    - Node.js should be installed as root or with `sudo` permissions on Pi for hardware permissions
- Git on personal computer and Raspberry Pi
- [3mm LED of any color](https://www.adafruit.com/product/4202)
- [Jumper wires for connecting LED to the Raspberry Pi's GPIO pins](https://www.adafruit.com/product/1950)

**Hardware Setup:**

1. With two female-to-female jumper wires, connect one end of each wire to the legs of the LED. 
1. Connect the other end of one wire to a [Ground pin](https://pinout.xyz/pinout/ground) on the Raspberry Pi. 
1. Connect the other wire to [Pin 11 / GPIO 17](https://pinout.xyz/pinout/pin11_gpio17/) on the Raspbeery Pi.

**Software Setup:**

1. Clone this project to your computer and Raspberry Pi: `git clone https://github.com/HipsterBrown/webrtc-robot-demo.git`
1. Install project dependencies in project repo on your computer and Raspberry Pi (this may require `sudo` before the `npm install`): `cd webrtc-robot-demo && npm install`
1. Make a copy of the `.env.example` file called `.env` on your computer and Raspberry Pi: `cp .env.example .env`
1. Update the environment variables in the `.env` file as needed:
    - `VITE_NTFY_TOPIC` should be a unique value to avoid conflicts with other ntfy.sh users, you can generate a name in [the app](https://ntfy.sh/app) through the "Subscribe to topic" modal (no account needed). Remember this value because it will be needed to connect to the Pi from the web app.
1. Start the web application server on your computer: `npm run start:client`
1. Start the robot server on the Raspberry Pi: `sudo npm run start:server`

When the robot server is ready, you will see the message "Robot server is ready and online!" logged to the console on the Raspberry Pi.
When it is ready, enter the topic name in the "Robot" field and click on the "Connect" button in the web application to create a WebRTC peer connection with the robot server.
If the connection is successful, the "Blink LED" button will be activated. Clicking that button should make the LED wired to the Raspberry Pi start to blink.

**For the camera streaming demo (`cam.html`):**

1. Connect any USB webcam to the Raspberry Pi
1. Make sure ffmpeg is installed on the Pi: `sudo apt install -y ffmpeg`
1. Start the web application the same way: `npm run start:client`
1. Add `cam.html` to the dev server URL to visit the demo page.
1. Start the robot server on the Raspberry Pi: `sudo npm run start:cam-server`

When the robot server is ready, you will see the message "Robot server is ready and online! Video will start on client request" logged to the console on the Raspberry Pi. When it is ready, click on the "Connect" button in the web application to create a WebRTC peer connection with the robot server.
When it is ready, enter the topic name in the "Robot" field and click on the "Connect" button in the web application to create a WebRTC peer connection with the robot server.
If the connection is successful, the "Blink LED" button will be activated. Clicking that button should make the LED wired to the Raspberry Pi start to blink. Click "Start video" will start streaming the video from the webcam at the default settings.


## License

Apache 2.0 - See [LICENSE](./LICENSE) file
