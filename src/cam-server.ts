import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import * as path from 'node:path';
import { JSONRPCServer, isJSONRPCRequest, isJSONRPCRequests } from 'json-rpc-2.0';
import * as five from 'johnny-five';
// @ts-expect-error dependency only available on Raspberry Pi
import { RaspiIO } from 'raspi-io';
import { Notifier, parseMessage, prepareMessage } from './lib/ntfy-signaling';
import type { RPCServer } from './lib/rpc';

const wrtc = require('@roamhq/wrtc');
const { RTCPeerConnection } = wrtc;
const { RTCVideoSource } = wrtc.nonstandard;

const DEFAULT_CONFIG = {
  webcamDevice: '/dev/video0',
  width: 1280,
  height: 720,
  framerate: 30,
  frameSkip: 0,
  quality: 'medium'
};

// Global state for video streaming
let frameWorker: Worker | null = null;
let videoSource: any = null;
let isVideoRunning = false;
let currentVideoConfig = { ...DEFAULT_CONFIG };

// Initialize and start worker thread for video processing
function initFrameWorker() {
  if (frameWorker) {
    frameWorker.terminate();
  }

  const workerPath = path.join(__dirname, 'frame-worker.js');
  frameWorker = new Worker(workerPath);

  // Handle messages from worker
  frameWorker.on('message', (message) => {
    switch (message.type) {
      case 'frame':
        if (videoSource) {
          try {
            // Send frame to WebRTC
            videoSource.onFrame({
              width: message.width,
              height: message.height,
              data: new Uint8Array(message.data.buffer)
            });
          } catch (e) {
            console.error('Error sending frame to WebRTC:', e);
          }
        }
        break;

      case 'initialized':
        console.log('Frame worker initialized:', message.config);
        break;

      case 'configUpdated':
        console.log('Frame worker config updated:', message.config);
        currentVideoConfig = message.config;
        break;

      case 'ffmpegStarted':
        console.log('ffmpeg started:', message.success ? 'success' : 'failed');
        isVideoRunning = message.success;
        break;

      case 'ffmpegStopped':
        console.log('ffmpeg stopped');
        isVideoRunning = false;
        break;

      case 'log':
        switch (message.level) {
          case 'error':
            console.error(message.message);
            break;
          case 'warn':
            console.warn(message.message);
            break;
          case 'debug':
            if (process.env.DEBUG) {
              console.log(message.message);
            }
            break;
          default:
            console.log(message.message);
        }
        break;
    }
  });

  // Handle worker errors
  frameWorker.on('error', (error) => {
    console.error('Frame worker error:', error);
  });

  // Handle worker exit
  frameWorker.on('exit', (code) => {
    console.log(`Frame worker exited with code ${code}`);
    frameWorker = null;
    isVideoRunning = false;
  });

  // Initialize the worker with current settings
  frameWorker.postMessage({
    type: 'init',
    config: currentVideoConfig
  });

  return frameWorker;
}

// Start video streaming
function startVideo() {
  if (!frameWorker) {
    initFrameWorker();
  }

  frameWorker?.postMessage({ type: 'start' });
  return { status: 'starting' };
}

// Stop video streaming
function stopVideo() {
  frameWorker?.postMessage({ type: 'stop' });
  return { status: 'stopping' };
}

// Update video configuration
function updateVideoConfig(config: any) {
  Object.assign(currentVideoConfig, config);

  if (frameWorker) {
    frameWorker.postMessage({
      type: 'updateConfig',
      config
    });
  }

  return { status: 'updated', config: currentVideoConfig };
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
    led.strobe(500);
  }

  // Create video source
  videoSource = new RTCVideoSource();
  const videoTrack = videoSource.createTrack();

  // Create peer connection configuration with video
  const peerConnection = new RTCPeerConnection({
    iceServers: [
      {
        urls: "stun:stun.relay.metered.ca:80"
      },
    ],
  });

  peerConnection.addTrack(videoTrack);
  console.log("Added video track to peer connection");

  // Setup signaling
  const defaultTopic = process.env.VITE_NTFY_TOPIC ?? 'wrtc'
  const notifier = new Notifier({ server: process.env.VITE_NTFY_SERVER, defaultTopic });
  notifier.addEventListener('close', console.log.bind(console, 'Notifications closed'));
  notifier.addEventListener('message', async (event: CustomEvent) => {
    if (event.detail.topic === defaultTopic) {
      try {
        const message = parseMessage(event.detail.message);
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
          await notifier.publish(prepareMessage({ clientId, ...peerConnection.localDescription?.toJSON() }))
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

  // Basic RPC methods
  robotServer.addMethod('test', function logTestMessage(message) {
    console.log('Got a message from RPC client!', message)
  });

  robotServer.addMethod('getStatus', getBoardStatus);
  robotServer.addMethod('blink', startBlink);

  robotServer.addMethod('startVideo', function() {
    console.log('RPC request to start video');
    if (isVideoRunning) {
      return { status: 'already_running', config: currentVideoConfig };
    }

    const result = startVideo();
    return { ...result, config: currentVideoConfig };
  });

  robotServer.addMethod('stopVideo', function() {
    console.log('RPC request to stop video');
    if (!isVideoRunning) {
      return { status: 'not_running' };
    }

    return stopVideo();
  });

  robotServer.addMethod('getVideoStatus', function() {
    return {
      status: isVideoRunning ? 'running' : 'not_running',
      config: currentVideoConfig
    };
  });

  robotServer.addMethod('updateVideoConfig', function(config) {
    console.log('RPC request to update video config:', config);
    return updateVideoConfig(config);
  });

  robotServer.addMethod('getAvailableResolutions', function() {
    return [
      { width: 320, height: 240, label: '320x240' },
      { width: 640, height: 480, label: '640x480' },
      { width: 800, height: 600, label: '800x600' },
      { width: 1280, height: 720, label: '720p' },
      { width: 1920, height: 1080, label: '1080p' },
    ];
  });

  peerConnection.addEventListener('icecandidate', async ({ candidate }) => {
    if (candidate) {
      notifier.publish(prepareMessage({ clientId, ...candidate?.toJSON() })).catch(console.error);
    }
  });

  // Connection events
  peerConnection.addEventListener('track', (event) => {
    console.log('Track event on server:', event.track.kind);
  });

  peerConnection.addEventListener('negotiationneeded', (event) => {
    console.log('Negotiation needed:', event);
  });

  peerConnection.addEventListener('connectionstatechange', () => {
    console.log('Connection state changed:', peerConnection.connectionState);

    // Automatically clean up when connection closes
    if (peerConnection.connectionState === 'disconnected' ||
      peerConnection.connectionState === 'failed' ||
      peerConnection.connectionState === 'closed') {
      console.log('WebRTC connection closed, cleaning up video resources');
      stopVideo();
    }
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

  console.log('Robot server is ready and online! Video will start on client request.')

  // Cleanup function for process exit
  function cleanup() {
    console.log('Performing cleanup...');
    stopVideo();

    if (frameWorker) {
      frameWorker.terminate();
      frameWorker = null;
    }
  }

  // Set up process exit handlers
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
