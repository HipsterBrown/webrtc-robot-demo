import './style.css'
import { JSONRPCClient, isJSONRPCResponse, isJSONRPCResponses } from 'json-rpc-2.0';
import pako from 'pako';
import { Notifier } from './lib/ntfy-signaling';
import type { RPCCLient } from './lib/rpc';

declare global {
  var receivebox: HTMLDivElement;
  var blinkButton: HTMLButtonElement;
  var videoElement: HTMLVideoElement;
  var connectionStatus: HTMLDivElement;
}

// function prepareMessage(message: Record<string, unknown>) {
//   return btoa(JSON.stringify(message));
// }
function prepareMessage(message: Record<string, unknown>): string {
  try {
    // Convert message to JSON string
    const jsonString = JSON.stringify(message);

    // Check if message is large (adjust threshold as needed)
    if (jsonString.length > 1000) {
      // Compress with pako (gzip)
      const compressed = pako.deflate(jsonString);

      // Convert to base64 string with compression flag
      return 'c:' + btoa(String.fromCharCode.apply(null, compressed));
    } else {
      // Use regular base64 encoding for small messages
      return 'u:' + btoa(jsonString);
    }
  } catch (error) {
    console.error('Error compressing message:', error);
    // Fallback to uncompressed
    return 'u:' + btoa(JSON.stringify(message));
  }
}

// function parseMessage(message: string) {
//   return JSON.parse(atob(message));
// }
function parseMessage(message: string): Record<string, unknown> {
  try {
    // Check if message is compressed
    if (message.startsWith('c:')) {
      // Extract base64 part (remove 'c:' prefix)
      const base64Data = message.substring(2);

      // Convert base64 to binary
      const binary = atob(base64Data);

      // Convert to Uint8Array
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }

      // Decompress
      const decompressed = pako.inflate(bytes);

      // Convert to string and parse
      return JSON.parse(new TextDecoder().decode(decompressed));
    } else if (message.startsWith('u:')) {
      // Uncompressed message, just decode base64
      return JSON.parse(atob(message.substring(2)));
    } else {
      // Legacy format without prefix (backward compatibility)
      return JSON.parse(atob(message));
    }
  } catch (error) {
    console.error('Error parsing message:', error);
    throw error;
  }
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

function main() {
  const clientId = crypto.randomUUID()

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
  })

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
        updateStatus('connected', 'Connected to webcam stream');
      };

      // Add error handling for video element
      globalThis.videoElement.onerror = (e) => {
        logMessage('Video element error', e);
      };
    }
  });

  const notifier = new Notifier({ server: import.meta.env.VITE_NTFY_SERVER, defaultTopic: import.meta.env.VITE_NTFY_TOPIC });
  notifier.addEventListener('close', console.log.bind(console, 'Notifications closed'));
  notifier.addEventListener('message', async (event: CustomEvent) => {
    try {
      const message = parseMessage(event.detail.message)
      if (message.clientId === clientId) return;
      logMessage('Signaling', message)

      if ('candidate' in message) {
        await remoteDescriptSet;
        await peerConnection.addIceCandidate(message);
      }

      if (message.type === 'offer') {
        console.log('Offer:', { message })
        logMessage('Received offer', { signalingState: peerConnection.signalingState });

        await peerConnection.setRemoteDescription(message);
        remoteSetResolver(true);

        logMessage('Set remote description', { signalingState: peerConnection.signalingState });

        const answer = await peerConnection.createAnswer();
        logMessage('Created answer', { signalingState: peerConnection.signalingState });

        await peerConnection.setLocalDescription(answer);
        logMessage('Set local description', { signalingState: peerConnection.signalingState });

        await notifier.publish(prepareMessage({ clientId, ...peerConnection.localDescription?.toJSON() }))
      }

      if (message.type === 'answer') {
        console.log('Answer:', { message })
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

  notifier.subscribe().catch(console.error);

  peerConnection.addEventListener('icecandidate', ({ candidate }) => {
    logMessage('ICE candidate', { candidate: candidate?.toJSON() });
    if (candidate) {
      notifier.publish(prepareMessage({ clientId, ...candidate?.toJSON() })).catch(console.error);
    }
  });

  peerConnection.addEventListener('datachannel', event => logMessage('datachannel', event));

  peerConnection.addEventListener('negotiationneeded', event => {
    logMessage('Negotiation needed', { event });
  });

  peerConnection.addEventListener('connectionstatechange', () => {
    logMessage('Connection state changed', peerConnection.connectionState);

    if (peerConnection.connectionState === 'connected') {
      updateStatus('connected', 'Connected to robot');
    } else if (peerConnection.connectionState === 'disconnected' ||
      peerConnection.connectionState === 'failed') {
      updateStatus('disconnected', 'Connection lost');
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
  const robotClient: RPCCLient = new JSONRPCClient(async (request) => {
    dataChannel.send(JSON.stringify(request));
  });

  dataChannel.addEventListener('open', event => {
    logMessage('Data channel open', { event });
    globalThis.blinkButton.removeAttribute('disabled');
  })
  dataChannel.addEventListener('close', event => {
    logMessage('Data channel closed', { event });
    globalThis.blinkButton.setAttribute('disabled', 'true');
  })
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
  })

  async function connectPeers() {
    updateStatus('connecting', 'Connecting to robot...');

    // IMPORTANT: Force inclusion of video in the offer
    // This ensures transceiver is set up even if no track is present yet
    const transceiver = peerConnection.addTransceiver('video', { direction: 'recvonly' });
    logMessage('Added video transceiver', { kind: transceiver.receiver.track.kind });

    const offer = await peerConnection.createOffer();

    logMessage('Created offer', { sdp: offer.sdp });
    await peerConnection.setLocalDescription(offer);
    logMessage('Set local description (offer)');

    await notifier.publish(prepareMessage({ clientId, ...peerConnection.localDescription?.toJSON() }));
    logMessage('Sent offer to server');
  }

  document.addEventListener("submit", function(event) {
    event.preventDefault();
    const form = event.target as HTMLFormElement;
    const { action } = form.dataset;

    switch (action) {
      case 'connect':
        connectPeers().catch(console.error);
        break;
      case 'disconnect':
        break;
      case 'sendMessage':
        robotClient.request('test', form.elements.message.value)
        form.elements.message.value = '';
        break;
      case 'blink':
        robotClient.request('blink', { pin: 'P1-7' });
        break;
      default:
        console.log('Unknown action')
    }
  })
}

document.addEventListener("DOMContentLoaded", main);
