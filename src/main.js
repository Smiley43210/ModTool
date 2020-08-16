require('update-electron-app')({updateInterval: '1 hour'});
// Modules to control application life and create native browser window
const {app, BrowserWindow, shell, ipcMain, dialog} = require('electron');
const path = require('path');

// Keep a global reference of the window object, if you don't, the window will
// be closed automatically when the JavaScript object is garbage collected.
let mainWindow;

function createWindow() {
	// Create the browser window.
	mainWindow = new BrowserWindow({
		width: 900,
		height: 600,
		webPreferences: {
			preload: path.join(__dirname, 'preload.js'),
			backgroundColor: '#121212',
			nodeIntegration: false
		}
	});
	mainWindow.setMenu(null);

	// and load the index.html of the app.
	mainWindow.loadFile('src/index.html');

	// Emitted when the window is closed.
	mainWindow.on('closed', () => {
		// Dereference the window object, usually you would store windows
		// in an array if your app supports multi windows, this is the time
		// when you should delete the corresponding element.
		mainWindow = null;
	});
}

if (require('electron-squirrel-startup')) {
	app.quit();
} else {
	// This method will be called when Electron has finished
	// initialization and is ready to create browser windows.
	// Some APIs can only be used after this event occurs.
	app.on('ready', () => {
		ipcMain.on('version', (event) => {
			event.returnValue = app.getVersion();
		});

		ipcMain.on('folder-select', (event, defaultPath, title) => {
			event.returnValue = dialog.showOpenDialogSync(mainWindow, {
				title: title,
				defaultPath,
				properties: ['openDirectory']
			});
		});

		ipcMain.on('show-folder', (event, openPath) => {
			shell.openPath(openPath);
		});

		ipcMain.on('open-devtools', (event) => {
			mainWindow.webContents.openDevTools();
		});
	});
	app.on('ready', createWindow);

	// Quit when all windows are closed.
	app.on('window-all-closed', () => {
		// On macOS it is common for applications and their menu bar
		// to stay active until the user quits explicitly with Cmd + Q
		if (process.platform !== 'darwin') {
			app.quit();
		}
	});

	app.on('activate', () => {
		// On macOS it's common to re-create a window in the app when the
		// dock icon is clicked and there are no other windows open.
		if (mainWindow === null) {
			createWindow();
		}
	});
}
