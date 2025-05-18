import './style.css'
import { JSONRPCClient, isJSONRPCResponse, isJSONRPCResponses } from 'json-rpc-2.0';
import { Notifier, prepareMessage, parseMessage } from './lib/ntfy-signaling';
import type { RPCCLient } from './lib/rpc';

declare global {
  var receivebox: HTMLDivElement;
  var blinkButton: HTMLButtonElement;
  var connectButton: HTMLButtonElement;
  var connectionStatus: HTMLDivElement;
}

function logMessage(label: string, ...args: any[]) {
  const nextMessage = document.createElement('p');
  const textContent = document.createTextNode(`${label}: \n${JSON.stringify(args, null, 2)}`);
  nextMessage.appendChild(textContent);
  globalThis.receivebox.appendChild(nextMessage);
}

function updateStatus(state: string, message: string) {
  globalThis.connectionStatus.textContent = message;
  globalThis.connectionStatus.className = state;
}

function main() {
  const clientId = crypto.randomUUID()
  let peerConnection = new RTCPeerConnection({
    iceServers: [
      {
        urls: "stun:stun.relay.metered.ca:80"
      },
    ]
  });
  let isConnected = false;
  let remoteSetResolver: (value: unknown) => void;
  const remoteDescriptSet = new Promise((resolve) => {
    remoteSetResolver = resolve;
  })
  let robotTopic = import.meta.env.VITE_NTFY_TOPIC;

  const notifier = new Notifier({ server: import.meta.env.VITE_NTFY_SERVER, defaultTopic: robotTopic });
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

        console.log('Recevied offer, signaling state after setRemoteDescription, before createAnswer', peerConnection.signalingState)
        const answer = await peerConnection.createAnswer();
        logMessage('Created answer', { signalingState: peerConnection.signalingState });

        await peerConnection.setLocalDescription(answer);
        logMessage('Set local description', { signalingState: peerConnection.signalingState });

        await notifier.publish(prepareMessage({ clientId, ...peerConnection.localDescription?.toJSON() }), robotTopic)
        console.log(peerConnection.connectionState, peerConnection.iceConnectionState)
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
    }
  });

  peerConnection.addEventListener('icecandidate', ({ candidate }) => {
    logMessage('ICE candidate', { candidate });
    if (candidate) {
      notifier.publish(prepareMessage({ clientId, ...candidate?.toJSON() }), robotTopic).catch(console.error);
    }
  })

  peerConnection.addEventListener('datachannel', event => logMessage('datachannel', event));

  peerConnection.addEventListener('negotiationneeded', event => logMessage('Negotiation needed', event));
  peerConnection.addEventListener('connectionstatechange', () => {
    logMessage('Connection state changed', peerConnection.connectionState)

    isConnected = peerConnection.connectionState === 'connected';

    if (isConnected) {
      updateStatus('connected', 'Connected to robot');
      globalThis.connectButton.setAttribute('disabled', 'true')
    } else if (peerConnection.connectionState === 'disconnected' ||
      peerConnection.connectionState === 'failed' ||
      peerConnection.connectionState === 'closed') {
      updateStatus('disconnected', 'Connection lost');
      globalThis.connectButton.removeAttribute('disabled')
    }
  });
  peerConnection.addEventListener('signalingstatechange', () => logMessage('Signaling state changed', peerConnection.signalingState));
  peerConnection.addEventListener('icegatheringstatechange', () => logMessage('ICE gathering state changed', peerConnection.iceGatheringState));
  peerConnection.addEventListener('iceconnectionstatechange', () => logMessage('ICE connection state changed', peerConnection.iceConnectionState));

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
    isConnected = true;
    updateStatus('connected', 'Connected to robot w/ data channel open')
    globalThis.blinkButton.removeAttribute('disabled');
  })
  dataChannel.addEventListener('close', event => {
    logMessage('Data channel closed', { event });
    globalThis.blinkButton.setAttribute('disabled', 'true');
    isConnected = false;
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

  async function connectPeers(topic: string) {
    robotTopic = topic
    notifier.subscribe(robotTopic).catch(console.error);
    updateStatus('connecting', 'Connecting to robot...');

    const offer = await peerConnection.createOffer();
    logMessage('Created offer', { sdp: offer.sdp });
    await peerConnection.setLocalDescription(offer)
    logMessage('Set local description (offer)');

    await notifier.publish(prepareMessage({ clientId, ...peerConnection.localDescription?.toJSON() }), robotTopic)
    logMessage('Sent offer to server');
  }

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
