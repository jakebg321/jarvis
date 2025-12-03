import dgram from 'dgram';
import { ipcMain } from 'electron';
import robot from 'robotjs';

const PORT = 41234;
const MULTICAST_ADDR = '224.0.0.1'; // Simple multicast for local network

export class NetworkService {
    private socket: dgram.Socket;

    constructor() {
        this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        this.setup();
    }

    setup() {
        this.socket.bind(PORT, () => {
            this.socket.setBroadcast(true);
            this.socket.setMulticastTTL(128);
            try {
                this.socket.addMembership(MULTICAST_ADDR);
                console.log(`NetworkService listening on ${PORT}`);
            } catch (e) {
                console.warn('Multicast membership failed (Network might be offline):', e);
            }
        });

        this.socket.on('message', (msg, rinfo) => {
            try {
                const command = JSON.parse(msg.toString());
                console.log(`Received command from ${rinfo.address}:`, command);
                this.executeCommand(command);
            } catch (e) {
                console.error('Invalid network message:', e);
            }
        });
    }

    broadcast(action: string) {
        const message = JSON.stringify({ action, timestamp: Date.now() });
        this.socket.send(message, PORT, MULTICAST_ADDR, (err) => {
            if (err) console.error('Broadcast error:', err);
            else console.log('Broadcasted:', action);
        });
    }

    executeCommand(command: any) {
        // Prevent executing own commands if needed, or allow for sync
        // For now, simple execution
        if (command.action === 'SWITCH_TAB') {
            robot.keyTap('tab', 'control');
        } else if (command.action === 'MINIMIZE') {
            robot.keyTap('down', 'command');
        }
    }
}
