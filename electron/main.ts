import { app, BrowserWindow, ipcMain, globalShortcut, screen } from 'electron'
import path from 'path'
import isDev from 'electron-is-dev'
import robot from 'robotjs'
import os from 'os'
import { NetworkService } from './network';
import { exec } from 'child_process';

const network = new NetworkService();

// Window state tracking
let win: BrowserWindow | null = null;
let isOverlayMode = false;
let isProcessingPaused = false;

// Overlay mode dimensions
const OVERLAY_WIDTH = 320;
const OVERLAY_HEIGHT = 400;

function createWindow() {
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;

    win = new BrowserWindow({
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
        // Initial position for overlay mode
        x: screenWidth - OVERLAY_WIDTH - 20,
        y: screenHeight - OVERLAY_HEIGHT - 20,
    })

    // Give network service access to window for IPC
    network.setMainWindow(win);

    // Track visibility for processing pause
    win.on('minimize', () => {
        isProcessingPaused = true;
        win?.webContents.send('processing-state', { paused: true });
        console.log('Window minimized - processing paused');
    });

    win.on('restore', () => {
        isProcessingPaused = false;
        win?.webContents.send('processing-state', { paused: false });
        console.log('Window restored - processing resumed');
    });

    win.on('hide', () => {
        isProcessingPaused = true;
        win?.webContents.send('processing-state', { paused: true });
    });

    win.on('show', () => {
        isProcessingPaused = false;
        win?.webContents.send('processing-state', { paused: false });
    });

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

// Toggle between fullscreen and overlay mode
function toggleOverlayMode() {
    if (!win) return;

    const primaryDisplay = screen.getPrimaryDisplay();
    const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;

    isOverlayMode = !isOverlayMode;

    if (isOverlayMode) {
        // Switch to overlay mode
        console.log('Switching to OVERLAY mode');
        win.setAlwaysOnTop(true, 'floating');
        win.unmaximize();
        win.setSize(OVERLAY_WIDTH, OVERLAY_HEIGHT);
        win.setPosition(screenWidth - OVERLAY_WIDTH - 20, screenHeight - OVERLAY_HEIGHT - 20);
        win.setResizable(true);
        win.setMinimumSize(200, 250);
    } else {
        // Switch to fullscreen mode
        console.log('Switching to FULLSCREEN mode');
        win.setAlwaysOnTop(false);
        win.setResizable(true);
        win.maximize();
    }

    // Notify renderer of mode change
    win.webContents.send('overlay-mode-changed', { isOverlay: isOverlayMode });
}

app.whenReady().then(() => {
    createWindow()

    // Register F9 for overlay toggle
    const f9Registered = globalShortcut.register('F9', () => {
        console.log('F9 pressed - toggling overlay mode');
        toggleOverlayMode();
    });
    if (!f9Registered) {
        console.error('Failed to register F9 shortcut');
    } else {
        console.log('F9 registered for overlay toggle');
    }

    // Register Ctrl+Shift+P for power mode cycling
    const powerRegistered = globalShortcut.register('CommandOrControl+Shift+P', () => {
        console.log('Ctrl+Shift+P pressed - cycling power mode');
        win?.webContents.send('cycle-power-mode');
    });
    if (!powerRegistered) {
        console.error('Failed to register Ctrl+Shift+P shortcut');
    } else {
        console.log('Ctrl+Shift+P registered for power mode cycle');
    }

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow()
        }
    })
})

// Clean up shortcuts on quit
app.on('will-quit', () => {
    globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit()
    }
})

// ============ IPC Handlers for Overlay/Power Mode ============

// Get machine hostname for auto-detection
ipcMain.handle('get-hostname', () => {
    return os.hostname();
});

// Get current overlay state
ipcMain.handle('get-overlay-state', () => {
    return { isOverlay: isOverlayMode, isPaused: isProcessingPaused };
});

// Set overlay mode programmatically
ipcMain.handle('set-overlay-mode', (_event, enabled: boolean) => {
    if (enabled !== isOverlayMode) {
        toggleOverlayMode();
    }
    return { success: true, isOverlay: isOverlayMode };
});

// ============ Existing Handlers ============

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
    console.log('Taking screenshot...');
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
    console.log(`Launching app: ${appName}`);

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
                console.log(`Launched ${appName}`);
                resolve({ success: true, app: appName });
            }
        });
    });
});

// Window throw handler (move window to direction)
ipcMain.handle('throw-window', async (_event, direction: 'left' | 'right' | 'up' | 'down') => {
    console.log(`Throwing window: ${direction}`);
    try {
        // Use Win+Shift+Arrow to move window to another monitor
        robot.keyTap(direction, ['command', 'shift']);
        return { success: true, direction };
    } catch (error) {
        console.error('Window throw error:', error);
        return { success: false, error: String(error) };
    }
});
