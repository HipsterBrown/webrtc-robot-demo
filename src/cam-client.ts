import './cam-style.css'
import { JSONRPCClient, isJSONRPCResponse, isJSONRPCResponses } from 'json-rpc-2.0';
import { Notifier, prepareMessage, parseMessage } from './lib/ntfy-signaling';
import type { RPCCLient } from './lib/rpc';

declare global {
  var receivebox: HTMLDivElement;
  var blinkButton: HTMLButtonElement;
  var connectButton: HTMLButtonElement;
  var videoElement: HTMLVideoElement;
  var connectionStatus: HTMLDivElement;
  var startVideoButton: HTMLButtonElement;
  var stopVideoButton: HTMLButtonElement;
  var resolutionSelect: HTMLSelectElement;
  var framerateInput: HTMLInputElement;
  var frameSkipInput: HTMLInputElement;
  var qualitySelect: HTMLSelectElement;
  var applyConfigButton: HTMLButtonElement;
}

function logMessage(label: string, ...args: any[]) {
  const nextMessage = document.createElement('p');
  const textContent = document.createTextNode(`${label}: \n${JSON.stringify(args, null, 2)}`);
  nextMessage.appendChild(textContent);
  globalThis.receivebox.appendChild(nextMessage);
  // Auto-scroll to bottom
  globalThis.receivebox.scrollTop = globalThis.receivebox.scrollHeight;
}

function updateStatus(state: string, message: string) {
  globalThis.connectionStatus.textContent = message;
  globalThis.connectionStatus.className = state;
}

function updateVideoControls(isConnected: boolean, isVideoRunning: boolean) {
  if (!globalThis.startVideoButton || !globalThis.stopVideoButton) return;

  if (isConnected) {
    globalThis.startVideoButton.disabled = isVideoRunning;
    globalThis.stopVideoButton.disabled = !isVideoRunning;
    globalThis.applyConfigButton.disabled = !isConnected;
  } else {
    globalThis.startVideoButton.disabled = true;
    globalThis.stopVideoButton.disabled = true;
    globalThis.applyConfigButton.disabled = true;
  }
}

function main() {
  const clientId = crypto.randomUUID();
  let robotClient: RPCCLient | null = null;
  let isVideoRunning = false;
  let isConnected = false;
  let robotTopic = import.meta.env.VITE_NTFY_TOPIC;

  // Configure peer connection to expect video
  const peerConnection = new RTCPeerConnection({
    iceServers: [
      {
        urls: "stun:stun.relay.metered.ca:80"
      },
    ]
  });

  let remoteSetResolver: (value: unknown) => void;
  const remoteDescriptSet = new Promise((resolve) => {
    remoteSetResolver = resolve;
  });

  // Handle incoming video tracks
  peerConnection.addEventListener('track', (event) => {
    logMessage('Received remote track', { kind: event.track.kind });

    if (event.track.kind === 'video') {
      logMessage('Received video track', { id: event.track.id });

      if (event.streams && event.streams[0]) {
        globalThis.videoElement.srcObject = event.streams[0];
        logMessage('Video stream set to video element');
      } else {
        logMessage('WARNING: Received track but no stream, creating MediaStream');
        // Create a MediaStream manually
        const stream = new MediaStream([event.track]);
        globalThis.videoElement.srcObject = stream;
      }

      // Add event listeners to check when video starts playing
      globalThis.videoElement.onloadedmetadata = () => {
        logMessage('Video metadata loaded', {
          width: globalThis.videoElement.videoWidth,
          height: globalThis.videoElement.videoHeight
        });
      };

      globalThis.videoElement.onplay = () => {
        logMessage('Video started playing');
        updateStatus('connected', 'Connected to robot and receiving video');
      };

      // Add error handling for video element
      globalThis.videoElement.onerror = (e) => {
        logMessage('Video element error', e);
      };
    }
  });

  const notifier = new Notifier({ server: import.meta.env.VITE_NTFY_SERVER, defaultTopic: robotTopic });
  notifier.addEventListener('close', console.log.bind(console, 'Notifications closed'));
  notifier.addEventListener('message', async (event: CustomEvent) => {
    try {
      const message = parseMessage(event.detail.message);
      if (message.clientId === clientId) return;
      logMessage('Signaling', message);

      if ('candidate' in message) {
        await remoteDescriptSet;
        await peerConnection.addIceCandidate(message);
      }

      if (message.type === 'offer') {
        console.log('Offer:', { message });
        logMessage('Received offer', { signalingState: peerConnection.signalingState });

        await peerConnection.setRemoteDescription(message);
        remoteSetResolver(true);

        logMessage('Set remote description', { signalingState: peerConnection.signalingState });

        const answer = await peerConnection.createAnswer();
        logMessage('Created answer', { signalingState: peerConnection.signalingState });

        await peerConnection.setLocalDescription(answer);
        logMessage('Set local description', { signalingState: peerConnection.signalingState });

        await notifier.publish(prepareMessage({ clientId, ...peerConnection.localDescription?.toJSON() }), robotTopic);
      }

      if (message.type === 'answer') {
        console.log('Answer:', { message });
        logMessage('Received answer', { signalingState: peerConnection.signalingState });

        await peerConnection.setRemoteDescription(message);
        remoteSetResolver(true);

        logMessage('Set remote description (answer)', {
          signalingState: peerConnection.signalingState,
          connectionState: peerConnection.connectionState
        });
      }
    } catch (error) {
      console.error('Unable to parse message', event.detail, error);
      logMessage('Error processing message', { error: error.message });
    }
  });

  peerConnection.addEventListener('icecandidate', ({ candidate }) => {
    logMessage('ICE candidate', { candidate: candidate?.toJSON() });
    if (candidate) {
      notifier.publish(prepareMessage({ clientId, ...candidate?.toJSON() }), robotTopic).catch(console.error);
    }
  });

  peerConnection.addEventListener('datachannel', event => logMessage('datachannel', event));

  peerConnection.addEventListener('negotiationneeded', event => {
    logMessage('Negotiation needed', { event });
  });

  peerConnection.addEventListener('connectionstatechange', () => {
    logMessage('Connection state changed', peerConnection.connectionState);

    isConnected = peerConnection.connectionState === 'connected';

    if (isConnected) {
      updateStatus('connected', 'Connected to robot');
      updateVideoControls(true, isVideoRunning);
      globalThis.connectButton.setAttribute('disabled', 'true');
    } else if (peerConnection.connectionState === 'disconnected' ||
      peerConnection.connectionState === 'failed' ||
      peerConnection.connectionState === 'closed') {
      updateStatus('disconnected', 'Connection lost');
      updateVideoControls(false, false);
      globalThis.connectButton.removeAttribute('disabled');
    }
  });

  peerConnection.addEventListener('signalingstatechange', () => {
    logMessage('Signaling state changed', peerConnection.signalingState);
  });

  peerConnection.addEventListener('icegatheringstatechange', () => {
    logMessage('ICE gathering state changed', peerConnection.iceGatheringState);
  });

  peerConnection.addEventListener('iceconnectionstatechange', () => {
    logMessage('ICE connection state changed', peerConnection.iceConnectionState);
  });

  const dataChannel = peerConnection.createDataChannel('data', {
    negotiated: true,
    ordered: true,
    id: 1,
  });
  robotClient = new JSONRPCClient(async (request) => {
    dataChannel.send(JSON.stringify(request));
  });

  dataChannel.addEventListener('open', event => {
    logMessage('Data channel open', { event });
    globalThis.blinkButton.removeAttribute('disabled');
    isConnected = true;
    updateVideoControls(true, isVideoRunning);

    // Query video status when connection is established
    if (robotClient) {
      robotClient.request('getVideoStatus')
        .then(({ status, config }) => {
          logMessage('Video status', status);
          isVideoRunning = status === 'running';
          updateVideoControls(true, isVideoRunning);

          // Update form fields with current settings
          if (globalThis.resolutionSelect) {
            globalThis.resolutionSelect.value = `${config.width}x${config.height}`;
          }
          if (globalThis.framerateInput) {
            globalThis.framerateInput.value = config.framerate;
          }
          if (globalThis.frameSkipInput) {
            globalThis.frameSkipInput.value = config.frameSkip;
          }
          if (globalThis.qualitySelect) {
            globalThis.qualitySelect.value = config.quality;
          }
        })
        .catch(console.error);

      // Get available resolutions
      robotClient.request('getAvailableResolutions')
        .then((resolutions) => {
          if (globalThis.resolutionSelect) {
            // Clear existing options
            globalThis.resolutionSelect.innerHTML = '';

            // Add options
            resolutions.forEach((res) => {
              const option = document.createElement('option');
              option.value = `${res.width}x${res.height}`;
              option.textContent = res.label || `${res.width}x${res.height}`;
              globalThis.resolutionSelect.appendChild(option);
            });
          }
        })
        .catch(console.error);
    }
  });

  dataChannel.addEventListener('close', event => {
    logMessage('Data channel closed', { event });
    globalThis.blinkButton.setAttribute('disabled', 'true');
    isConnected = false;
    updateVideoControls(false, false);
  });

  dataChannel.addEventListener('message', ({ data }) => {
    logMessage('Data channel message', { data });
    try {
      const rpc = JSON.parse(data);
      if (isJSONRPCResponse(rpc) || isJSONRPCResponses(rpc)) {
        robotClient.receive(rpc);
      }
    } catch (error) {
      console.error(error);
    }
  });

  async function connectPeers(topic: string) {
    robotTopic = topic
    notifier.subscribe(robotTopic).catch(console.error);
    updateStatus('connecting', 'Connecting to robot...');

    const transceiver = peerConnection.addTransceiver('video', { direction: 'recvonly' });
    logMessage('Added video transceiver', { mid: transceiver.mid });

    const offer = await peerConnection.createOffer();

    logMessage('Created offer', { sdp: offer.sdp });
    await peerConnection.setLocalDescription(offer);
    logMessage('Set local description (offer)');

    await notifier.publish(prepareMessage({ clientId, ...peerConnection.localDescription?.toJSON() }), robotTopic);
    logMessage('Sent offer to server');
  }

  // Video control functions
  async function startVideo() {
    if (!robotClient) return;

    try {
      const result = await robotClient.request('startVideo');
      logMessage('Start video result', result);

      if (result.status === 'started' || result.status === 'starting' || result.status === 'already_running') {
        isVideoRunning = true;
        updateVideoControls(isConnected, true);
      }
    } catch (error) {
      logMessage('Error starting video', { error });
    }
  }

  async function stopVideo() {
    if (!robotClient) return;

    try {
      const result = await robotClient.request('stopVideo');
      logMessage('Stop video result', result);

      if (result.status === 'stopped' || result.status === 'stopping') {
        isVideoRunning = false;
        updateVideoControls(isConnected, false);
      }
    } catch (error) {
      logMessage('Error stopping video', { error });
    }
  }

  async function updateVideoConfig() {
    if (!robotClient) return;

    try {
      // Get values from form
      const resolution = globalThis.resolutionSelect.value.split('x');
      const width = parseInt(resolution[0]);
      const height = parseInt(resolution[1]);
      const framerate = parseInt(globalThis.framerateInput.value);
      const frameSkip = parseInt(globalThis.frameSkipInput.value);
      const quality = globalThis.qualitySelect.value;

      const result = await robotClient.request('updateVideoConfig', {
        width,
        height,
        framerate,
        frameSkip,
        quality
      });

      logMessage('Update video config result', result);
    } catch (error) {
      logMessage('Error updating video config', { error });
    }
  }

  // Set up event listeners
  document.addEventListener("submit", function(event) {
    event.preventDefault();
    const form = event.target as HTMLFormElement;
    const { action } = form.dataset;

    switch (action) {
      case 'connect':
        connectPeers(form.elements.ntfyTopic.value.trim()).catch(console.error);
        break;
      case 'disconnect':
        break;
      case 'sendMessage':
        if (robotClient) {
          robotClient.request('test', form.elements.message.value);
          form.elements.message.value = '';
        }
        break;
      case 'blink':
        if (robotClient) {
          robotClient.request('blink', { pin: 'P1-7' });
        }
        break;
      case 'startVideo':
        startVideo().catch(console.error);
        break;
      case 'stopVideo':
        stopVideo().catch(console.error);
        break;
      case 'updateVideoConfig':
        updateVideoConfig().catch(console.error);
        break;
      default:
        console.log('Unknown action');
    }
  });
}

document.addEventListener("DOMContentLoaded", main);
