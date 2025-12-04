import dgram from 'dgram';
import { ipcMain, BrowserWindow } from 'electron';
import robot from 'robotjs';
import os from 'os';

const PORT = 41234;
const MULTICAST_ADDR = '224.0.0.1';
const MACHINE_NAME = os.hostname();

export class NetworkService {
    private socket: dgram.Socket;
    private mainWindow: BrowserWindow | null = null;

    constructor() {
        this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        this.setup();
        this.setupIPC();
    }

    setMainWindow(win: BrowserWindow) {
        this.mainWindow = win;
    }

    setup() {
        this.socket.bind(PORT, () => {
            this.socket.setBroadcast(true);
            this.socket.setMulticastTTL(128);
            try {
                this.socket.addMembership(MULTICAST_ADDR);
                console.log(`NetworkService listening on ${PORT} as "${MACHINE_NAME}"`);
            } catch (e) {
                console.warn('Multicast membership failed:', e);
            }
        });

        this.socket.on('message', (msg, rinfo) => {
            try {
                const data = JSON.parse(msg.toString());
                // Ignore own messages
                if (data.from === MACHINE_NAME) return;

                console.log(`Received from ${data.from} (${rinfo.address}):`, data);

                // Forward to renderer
                if (this.mainWindow) {
                    this.mainWindow.webContents.send('network-message', {
                        ...data,
                        ip: rinfo.address
                    });
                }

                // Handle ping - respond with pong
                if (data.action === 'PING') {
                    this.broadcast('PONG');
                }

                // Execute commands
                this.executeCommand(data);
            } catch (e) {
                console.error('Invalid network message:', e);
            }
        });

        this.socket.on('error', (err) => {
            console.error('Socket error:', err);
        });
    }

    setupIPC() {
        // Send test ping
        ipcMain.handle('network-ping', () => {
            this.broadcast('PING');
            return { success: true, from: MACHINE_NAME };
        });

        // Send custom message
        ipcMain.handle('network-send', (_event, message: string) => {
            this.broadcast(message);
            return { success: true };
        });

        // Get network info
        ipcMain.handle('network-info', () => {
            const interfaces = os.networkInterfaces();
            const ips: string[] = [];
            for (const name of Object.keys(interfaces)) {
                for (const iface of interfaces[name] || []) {
                    if (iface.family === 'IPv4' && !iface.internal) {
                        ips.push(iface.address);
                    }
                }
            }
            return {
                hostname: MACHINE_NAME,
                ips,
                port: PORT
            };
        });
    }

    broadcast(action: string, extra?: Record<string, unknown>) {
        const message = JSON.stringify({
            action,
            from: MACHINE_NAME,
            timestamp: Date.now(),
            ...extra
        });
        this.socket.send(message, PORT, MULTICAST_ADDR, (err) => {
            if (err) console.error('Broadcast error:', err);
            else console.log('Broadcasted:', action);
        });
    }

    executeCommand(command: { action: string; from: string }) {
        if (command.action === 'SWITCH_TAB') {
            robot.keyTap('tab', 'control');
        } else if (command.action === 'MINIMIZE') {
            robot.keyTap('down', 'command');
        }
        // PING/PONG are handled above, no action needed
    }
}
