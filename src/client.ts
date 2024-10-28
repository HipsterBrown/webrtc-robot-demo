import './style.css'
import { JSONRPCClient, isJSONRPCResponse, isJSONRPCResponses } from 'json-rpc-2.0';
import { Notifier } from './lib/ntfy-signaling';
import type { RPCCLient } from './lib/rpc';

declare global {
  var receivebox: HTMLDivElement;
  var blinkButton: HTMLButtonElement;
}

function prepareMessage(message: Record<string, unknown>) {
  return btoa(JSON.stringify(message));
}

function parseMessage(message: string) {
  return JSON.parse(atob(message));
}

function logMessage(label: string, ...args: any[]) {
  const nextMessage = document.createElement('p');
  const textContent = document.createTextNode(`${label}: \n${JSON.stringify(args, null, 2)}`);
  nextMessage.appendChild(textContent);
  globalThis.receivebox.appendChild(nextMessage);
}

function main() {
  const clientId = crypto.randomUUID()
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
        console.log('Recevied offer, signaling state before setRemoteDescription', peerConnection.signalingState)
        await peerConnection.setRemoteDescription(message);
        remoteSetResolver(true);
        console.log('Recevied offer, signaling state after setRemoteDescription, before createAnswer', peerConnection.signalingState)
        const answer = await peerConnection.createAnswer();
        console.log('Recevied offer, signaling state after createAnswer, before setLocalDescription', peerConnection.signalingState)
        await peerConnection.setLocalDescription(answer);
        console.log('Recevied offer, signaling state after createAnswer, after setLocalDescription', peerConnection.signalingState)
        await notifier.publish(prepareMessage({ clientId, ...peerConnection.localDescription?.toJSON() }))
        console.log(peerConnection.connectionState, peerConnection.iceConnectionState)
      }

      if (message.type === 'answer') {
        console.log('Answer:', { message })
        console.log('Recevied answer, signaling state before setRemoteDescription', peerConnection.signalingState)
        await peerConnection.setRemoteDescription(message);
        remoteSetResolver(true);
      }
    } catch (error) {
      console.error('Unable to parse message', event.detail, error);
    }
  });

  notifier.subscribe().catch(console.error);

  peerConnection.addEventListener('icecandidate', ({ candidate }) => {
    logMessage('ICE candidate', { candidate });
    if (candidate) {
      notifier.publish(prepareMessage({ clientId, ...candidate?.toJSON() })).catch(console.error);
    }
  })

  peerConnection.addEventListener('datachannel', event => logMessage('datachannel', event));

  peerConnection.addEventListener('negotiationneeded', event => logMessage('Negotiation needed', event));
  peerConnection.addEventListener('connectionstatechange', () => logMessage('Connection state changed', peerConnection.connectionState));
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
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer)

    await notifier.publish(prepareMessage({ clientId, ...peerConnection.localDescription?.toJSON() }))
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
