import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { JSONRPCServer, isJSONRPCRequest, isJSONRPCRequests } from 'json-rpc-2.0';
import * as five from 'johnny-five';
// @ts-expect-error dependency only available on Raspberry Pi
import { RaspiIO } from 'raspi-io';
import { Notifier } from './lib/ntfy-signaling';
import type { RPCServer } from './lib/rpc';
import * as zlib from 'node:zlib';
import { promisify } from 'node:util';

const wrtc = require('@roamhq/wrtc');
const { RTCPeerConnection } = wrtc;
const { RTCVideoSource } = wrtc.nonstandard;

const gzip = promisify(zlib.deflate);
const gunzip = promisify(zlib.inflate);

// Webcam configuration
const WEBCAM_DEVICE = '/dev/video0';
const VIDEO_WIDTH = 640;
const VIDEO_HEIGHT = 480;
const FRAMERATE = 30;
const FRAME_SIZE = VIDEO_WIDTH * VIDEO_HEIGHT * 1.5; // YUV420p frame size
const VIDEO_FILE = '/tmp/webcam_frames.yuv';

async function prepareMessage(message: Record<string, unknown>): Promise<string> {
  try {
    // Convert message to JSON string
    const jsonString = JSON.stringify(message);

    // Check if message is large (adjust threshold as needed)
    if (jsonString.length > 1000) {
      // Compress with zlib
      const compressed = await gzip(Buffer.from(jsonString));

      // Convert to base64 string with compression flag
      return 'c:' + compressed.toString('base64');
    } else {
      // Use regular base64 encoding for small messages
      return 'u:' + Buffer.from(jsonString).toString('base64');
    }
  } catch (error) {
    console.error('Error compressing message:', error);
    // Fallback to uncompressed
    return 'u:' + Buffer.from(JSON.stringify(message)).toString('base64');
  }
}

async function parseMessage(message: string): Promise<Record<string, unknown>> {
  try {
    // Check if message is compressed
    if (message.startsWith('c:')) {
      // Extract base64 part (remove 'c:' prefix)
      const base64Data = message.substring(2);

      // Convert base64 to buffer
      const buffer = Buffer.from(base64Data, 'base64');

      // Decompress
      const decompressed = await gunzip(buffer);

      // Parse the JSON
      return JSON.parse(decompressed.toString());
    } else if (message.startsWith('u:')) {
      // Uncompressed message, just decode base64
      return JSON.parse(Buffer.from(message.substring(2), 'base64').toString());
    } else {
      // Legacy format without prefix (backward compatibility)
      return JSON.parse(Buffer.from(message, 'base64').toString());
    }
  } catch (error) {
    console.error('Error parsing message:', error);
    throw error;
  }
}

// Start ffmpeg process to capture from webcam
function startFFmpeg() {
  console.log('Starting ffmpeg process...');

  // Ensure old file is removed
  try {
    if (fs.existsSync(VIDEO_FILE)) {
      fs.unlinkSync(VIDEO_FILE);
    }
  } catch (err) {
    console.warn('Failed to delete old video file:', err.message);
  }

  const ffmpegArgs = [
    '-f', 'v4l2',
    '-framerate', String(FRAMERATE),
    '-video_size', `${VIDEO_WIDTH}x${VIDEO_HEIGHT}`,
    '-i', WEBCAM_DEVICE,

    // Convert to raw YUV - CRITICAL: must match exactly what WebRTC expects
    '-pix_fmt', 'yuv420p',

    // Output raw video to file
    '-f', 'rawvideo',
    '-y', VIDEO_FILE
  ];

  console.log('ffmpeg command:', 'ffmpeg', ffmpegArgs.join(' '));

  // Create ffmpeg process
  const ffmpeg = spawn('ffmpeg', ffmpegArgs);

  ffmpeg.stderr.on('data', (data) => {
    // Print ffmpeg logs
    const log = data.toString();
    if (log.includes('error') || log.includes('fatal')) {
      console.error(`ffmpeg: ${log}`);
    } else if (process.env.DEBUG) {
      console.log(`ffmpeg: ${log}`);
    }
  });

  ffmpeg.on('close', (code) => {
    console.log(`ffmpeg process exited with code ${code}`);
  });

  return ffmpeg;
}

// Read video frames from the file and send them via the video track
function readVideoFrames(videoSource: any) {
  console.log('Starting to watch for video frames...');

  // Make sure we have the latest version of the file
  let lastSize = 0;
  let frameBuffer = Buffer.alloc(0);

  // Check file every 30ms (roughly matching 30fps)
  const interval = setInterval(() => {
    try {
      if (!videoSource) return;

      if (!fs.existsSync(VIDEO_FILE)) return;

      const stats = fs.statSync(VIDEO_FILE);
      if (stats.size === lastSize) return; // No new data

      // Read only new data
      const fd = fs.openSync(VIDEO_FILE, 'r');
      const newDataSize = stats.size - lastSize;
      const buffer = Buffer.alloc(newDataSize);
      fs.readSync(fd, buffer, 0, newDataSize, lastSize);
      fs.closeSync(fd);

      // Update last size
      lastSize = stats.size;

      // Add to frame buffer
      frameBuffer = Buffer.concat([frameBuffer, buffer]);

      // Process complete frames
      while (frameBuffer.length >= FRAME_SIZE) {
        const frameData = frameBuffer.slice(0, FRAME_SIZE);
        frameBuffer = frameBuffer.slice(FRAME_SIZE);

        try {
          // Send frame to WebRTC
          // Log to verify we're getting frames
          console.log(`Sending video frame: ${frameData.length} bytes`);
          videoSource.onFrame({
            width: VIDEO_WIDTH,
            height: VIDEO_HEIGHT,
            data: new Uint8Array(frameData)
          });
        } catch (e) {
          console.error('Error sending frame:', e);
        }
      }
    } catch (err) {
      console.error('Error reading video frame:', err);
    }
  }, 30);

  return interval;
}

async function main() {
  const clientId = randomUUID();
  let isBoardReady = false;
  const board = new five.Board({
    io: new RaspiIO(),
  });

  board.on('ready', () => {
    isBoardReady = true;
  });

  function getBoardStatus() {
    if (isBoardReady) return 'ready';
    return 'unavailable';
  }

  function startBlink({ pin }: { pin: string }) {
    if (!isBoardReady) throw new Error('Robot is not ready!')
    const led = new five.Led(pin);
    led.blink();
  }

  // Important: Create video source BEFORE setting up peer connection
  const videoSource = new RTCVideoSource();
  const videoTrack = videoSource.createTrack();

  // Start video capture and processing
  const ffmpegProcess = startFFmpeg();
  const frameInterval = readVideoFrames(videoSource);

  // Create peer connection configuration with video
  const peerConnection = new RTCPeerConnection({
    iceServers: [
      {
        urls: "stun:stun.relay.metered.ca:80"
      },
    ],
  });

  // Add video track to peer connection
  // IMPORTANT: Add the track before any signaling happens
  const sender = peerConnection.addTrack(videoTrack);
  console.log("Added video track to peer connection");

  // Setup signaling
  const defaultTopic = process.env.VITE_NTFY_TOPIC ?? 'wrtc'
  const notifier = new Notifier({ server: process.env.VITE_NTFY_SERVER, defaultTopic });
  notifier.addEventListener('close', console.log.bind(console, 'Notifications closed'));
  notifier.addEventListener('message', async (event: CustomEvent) => {
    if (event.detail.topic === defaultTopic) {
      try {
        const message = await parseMessage(event.detail.message);
        if (message.clientId === clientId) return;

        if ('candidate' in message) {
          await peerConnection.addIceCandidate(message);
        }

        if (message.type === 'offer') {
          console.log('Offer:', { message })
          console.log('Recevied offer, signaling state before setRemoteDescription', peerConnection.signalingState)
          await peerConnection.setRemoteDescription(message);
          console.log('Recevied offer, signaling state after setRemoteDescription, before createAnswer', peerConnection.signalingState)
          const answer = await peerConnection.createAnswer();
          console.log('Recevied offer, signaling state after createAnswer, before setLocalDescription', peerConnection.signalingState)
          await peerConnection.setLocalDescription(answer);
          console.log('Recevied offer, signaling state after createAnswer, after setLocalDescription', peerConnection.signalingState)
          await notifier.publish(await prepareMessage({ clientId, ...peerConnection.localDescription?.toJSON() }))
          console.log(peerConnection.connectionState, peerConnection.iceConnectionState)
        }

        if (message.type === 'answer') {
          console.log('Setting remote description with answer', peerConnection.signalingState);
          await peerConnection.setRemoteDescription(message);
          console.log('Set remote description with answer', peerConnection.signalingState, peerConnection.connectionState);
        }
      } catch (error) {
        console.error('Unable to parse message', event.detail);
      }
    }
  });

  notifier.subscribe().catch(console.error);

  const robotServer: RPCServer = new JSONRPCServer();
  const dataChannel = peerConnection.createDataChannel('data', {
    negotiated: true,
    ordered: true,
    id: 1,
  });
  dataChannel.addEventListener('open', console.log.bind(console, 'Data channel open'));
  dataChannel.addEventListener('close', console.log.bind(console, 'Data channel close'));
  dataChannel.addEventListener('message', async ({ data }) => {
    console.log('Message data:', data);
    try {
      const rpc = JSON.parse(data.toString());

      if (isJSONRPCRequests(rpc) || isJSONRPCRequest(rpc)) {
        const response = await robotServer.receive(rpc);
        dataChannel.send(JSON.stringify(response));
      }
    } catch (error) {
      console.warn('Unable to parse message', data);
    }
  });

  robotServer.addMethod('test', function logTestMessage(message) {
    console.log('Got a message from RPC client!', message)
  });

  robotServer.addMethod('getStatus', getBoardStatus);
  robotServer.addMethod('blink', startBlink);

  peerConnection.addEventListener('icecandidate', async ({ candidate }) => {
    if (candidate) {
      notifier.publish(await prepareMessage({ clientId, ...candidate?.toJSON() })).catch(console.error);
    }
  });

  // Log track events on server side
  peerConnection.addEventListener('track', (event) => {
    console.log('Track event on server:', event.track.kind);
  });

  peerConnection.addEventListener('negotiationneeded', (event) => {
    console.log('Negotiation needed:', event);
  });

  peerConnection.addEventListener('connectionstatechange', () => {
    console.log('Connection state changed:', peerConnection.connectionState);
  });

  peerConnection.addEventListener('signalingstatechange', () => {
    console.log('Signaling state changed:', peerConnection.signalingState);
  });

  peerConnection.addEventListener('icegatheringstatechange', () => {
    console.log('ICE gathering state changed:', peerConnection.iceGatheringState);
  });

  peerConnection.addEventListener('iceconnectionstatechange', () => {
    console.log('ICE connection state changed:', peerConnection.iceConnectionState);
  });

  console.log('Robot server is ready and online with video streaming!')

  // Cleanup function for process exit
  function cleanup() {
    if (ffmpegProcess) {
      ffmpegProcess.kill('SIGTERM');
    }

    if (frameInterval) {
      clearInterval(frameInterval);
    }

    try {
      if (fs.existsSync(VIDEO_FILE)) {
        fs.unlinkSync(VIDEO_FILE);
      }
    } catch (e) {
      // Ignore errors
    }
  }

  process.on('exit', cleanup);
  process.on('SIGINT', () => {
    console.log('Received SIGINT, shutting down...');
    cleanup();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    console.log('Received SIGTERM, shutting down...');
    cleanup();
    process.exit(0);
  });
}

main().catch(console.error);
