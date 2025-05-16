import { randomUUID } from 'node:crypto';
import { JSONRPCServer, isJSONRPCRequest, isJSONRPCRequests } from 'json-rpc-2.0';
import * as five from 'johnny-five';
// @ts-expect-error dependency only available on Raspberry Pi
import { RaspiIO } from 'raspi-io';
import { Notifier } from './lib/ntfy-signaling';
import type { RPCServer } from './lib/rpc';

const { RTCPeerConnection } = require('@roamhq/wrtc');

function prepareMessage(message: Record<string, unknown>) {
  return btoa(JSON.stringify(message));
}

function parseMessage(message: string) {
  return JSON.parse(atob(message));
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

  const peerConnection = new RTCPeerConnection({
    iceServers: [
      {
        urls: "stun:stun.relay.metered.ca:80"
      },
    ],
  });
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

  robotServer.addMethod('test', function logTestMessage(message) {
    console.log('Got a message from RPC client!', message)
  });

  robotServer.addMethod('getStatus', getBoardStatus);
  robotServer.addMethod('blink', startBlink);

  peerConnection.addEventListener('negotiationneeded', console.log.bind(console, 'Negotiation needed:'));
  peerConnection.addEventListener('connectionstatechange', console.log.bind(console, 'Connection state changed:'));
  peerConnection.addEventListener('signalingstatechange', () => console.log('Signaling state changed:', peerConnection.signalingState));
  peerConnection.addEventListener('icegatheringstatechange', () => console.log('ICE gathering state changed:', peerConnection.iceGatheringState));
  peerConnection.addEventListener('iceconnectionstatechange', () => console.log('ICE connection state changed:', peerConnection.iceConnectionState));

  console.log('Robot server is ready and online!')
}

main().catch(console.error);
