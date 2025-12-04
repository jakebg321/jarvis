import { app, BrowserWindow, ipcMain, desktopCapturer, screen } from 'electron'
import path from 'path'
import isDev from 'electron-is-dev'
import robot from 'robotjs'
import { NetworkService } from './network';
import { exec } from 'child_process';

const network = new NetworkService();

function createWindow() {
    const win = new BrowserWindow({
        width: 1200,
        height: 800,
        fullscreen: false,
        fullscreenable: true,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false, // For easier RobotJS access in prototype
            webSecurity: false, // Allow loading local resources
        },
        frame: false, // Tony Stark style (frameless)
        transparent: true, // Glassmorphism support
        alwaysOnTop: false,
    })

    // Give network service access to window for IPC
    network.setMainWindow(win);

    // Maximize on start for borderless fullscreen effect (can still alt-tab)
    win.maximize()

    // Load the local URL for development or the local file for production
    if (isDev) {
        win.loadURL('http://localhost:5173')
        win.webContents.openDevTools()
    } else {
        win.loadFile(path.join(__dirname, '../dist/index.html'))
    }
}

app.whenReady().then(() => {
    createWindow()

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow()
        }
    })
})

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit()
    }
})

// App mappings for finger gestures
const APP_MAPPINGS: Record<string, string> = {
    'POINTING_UP': 'chrome',      // 1 finger = Browser
    'PEACE_SIGN': '',             // 2 fingers = Screenshot (special)
    'THREE_FINGERS': 'code',      // 3 fingers = VS Code
    'FOUR_FINGERS': 'slack',      // 4 fingers = Slack
    'OPEN_PALM': 'explorer',      // 5 fingers = File Explorer
};

ipcMain.on('gesture-detected', (event, gesture) => {
    console.log('Gesture received:', gesture);

    try {
        if (gesture === 'CLOSED_FIST') {
            // Minimize Window (Win + Down)
            robot.keyTap('down', 'command');
            network.broadcast('MINIMIZE');
            console.log('Action: Minimize');
        } else if (gesture === 'OPEN_PALM') {
            // Switch Tab (Ctrl + Tab)
            robot.keyTap('tab', 'control');
            network.broadcast('SWITCH_TAB');
            console.log('Action: Switch Tab');
        }
    } catch (error) {
        console.error('RobotJS Error:', error);
    }
});

// Screenshot handler
ipcMain.handle('take-screenshot', async () => {
    console.log('📸 Taking screenshot...');
    try {
        // Use Windows PrintScreen key
        robot.keyTap('printscreen', 'command'); // Win+PrintScreen saves to Screenshots folder
        return { success: true, message: 'Screenshot saved to Pictures/Screenshots' };
    } catch (error) {
        console.error('Screenshot error:', error);
        return { success: false, error: String(error) };
    }
});

// App launcher handler
ipcMain.handle('launch-app', async (_event, appName: string) => {
    console.log(`🚀 Launching app: ${appName}`);

    const commands: Record<string, string> = {
        'chrome': 'start chrome',
        'code': 'code',
        'slack': 'start slack:',
        'explorer': 'explorer',
        'discord': 'start discord:',
        'terminal': 'start wt', // Windows Terminal
        'notepad': 'notepad',
        'spotify': 'start spotify:',
    };

    const cmd = commands[appName.toLowerCase()];
    if (!cmd) {
        return { success: false, error: `Unknown app: ${appName}` };
    }

    return new Promise((resolve) => {
        exec(cmd, { shell: 'cmd.exe' }, (error) => {
            if (error) {
                console.error(`Failed to launch ${appName}:`, error);
                resolve({ success: false, error: String(error) });
            } else {
                console.log(`✅ Launched ${appName}`);
                resolve({ success: true, app: appName });
            }
        });
    });
});

// Window throw handler (move window to direction)
ipcMain.handle('throw-window', async (_event, direction: 'left' | 'right' | 'up' | 'down') => {
    console.log(`🎯 Throwing window: ${direction}`);
    try {
        // Use Win+Shift+Arrow to move window to another monitor
        robot.keyTap(direction, ['command', 'shift']);
        return { success: true, direction };
    } catch (error) {
        console.error('Window throw error:', error);
        return { success: false, error: String(error) };
    }
});
