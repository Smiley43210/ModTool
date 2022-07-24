require('update-electron-app')({updateInterval: '1 hour', notifyUser: false});
// Modules to control application life and create native browser window
const {app, BrowserWindow, shell, ipcMain, dialog, autoUpdater} = require('electron');
const path = require('path');
let updateState = null;

// Keep a global reference of the window object, if you don't, the window will
// be closed automatically when the JavaScript object is garbage collected.
let mainWindow = null;
const windows = [];

function createWindow() {
	// Create the browser window.
	mainWindow = new BrowserWindow({
		width: 950,
		height: 650,
		webPreferences: {
			preload: path.join(__dirname, 'preload.js'),
			backgroundColor: '#121212',
			nodeIntegration: false,
			nativeWindowOpen: true,
			contextIsolation: false,
		},
		show: false,
	});
	mainWindow.setMenu(null);

	// and load the index.html of the app.
	mainWindow.loadFile('src/index.html');
	
	// Prevent white background flash
	mainWindow.once('ready-to-show', () => {
		mainWindow.show();
	});

	// Emitted when the window is closed.
	mainWindow.on('closed', () => {
		// Dereference the window object, usually you would store windows
		// in an array if your app supports multi windows, this is the time
		// when you should delete the corresponding element.
		mainWindow = null;
	});
}

function setupUpdateListeners() {
	autoUpdater.on('error', () => {
		updateState = 'error';
		if (mainWindow) {
			mainWindow.webContents.send('update-check', updateState);
		}
	});
	autoUpdater.on('checking-for-update', () => {
		updateState = 'checking';
		if (mainWindow) {
			mainWindow.webContents.send('update-check', updateState);
		}
	});
	autoUpdater.on('update-available', () => {
		updateState = 'available';
		if (mainWindow) {
			mainWindow.webContents.send('update-check', updateState);
		}
	});
	autoUpdater.on('update-not-available', () => {
		updateState = null;
		if (mainWindow) {
			mainWindow.webContents.send('update-check', updateState);
		}
	});
	autoUpdater.on('update-downloaded', () => {
		updateState = 'downloaded';
		if (mainWindow) {
			mainWindow.webContents.send('update-check', updateState);
		}
	});
}

if (require('electron-squirrel-startup')) {
	app.quit();
} else {
	setupUpdateListeners();
	
	// This method will be called when Electron has finished
	// initialization and is ready to create browser windows.
	// Some APIs can only be used after this event occurs.
	app.on('ready', () => {
		ipcMain.on('version', (event) => {
			event.returnValue = app.getVersion();
		});
		
		ipcMain.on('update-check', (event) => {
			event.reply('update-check', updateState);
		});
		
		ipcMain.on('update-restart', (event) => {
			autoUpdater.quitAndInstall();
		});

		ipcMain.on('folder-select', (event, defaultPath, title) => {
			event.returnValue = dialog.showOpenDialogSync(mainWindow, {
				title: title,
				defaultPath,
				properties: ['openDirectory'],
			});
		});

		ipcMain.on('show-folder', (event, openPath) => {
			shell.openPath(openPath);
		});

		ipcMain.on('open-devtools', (event) => {
			mainWindow.webContents.openDevTools();
		});
		
		ipcMain.on('manual-mod', (event, mod, url, location) => {
			// Create the browser window.
			const window = new BrowserWindow({
				width: 1100,
				height: 700,
				webPreferences: {
					backgroundColor: '#121212',
					nodeIntegration: false,
				},
			});

			// Load a remote URL
			window.loadURL(url);
			// Notify window of wait
			event.reply('manual-mod', mod, 'waiting');

			window.webContents.session.on('will-download', (downloadEvent, item, webContents) => {
				// Set the save path, making Electron not to prompt a save dialog.
				item.setSavePath(path.join(location, item.getFilename()));
				
				// Notify window of download
				event.reply('manual-mod', mod, 'downloading');

				item.on('updated', (updateEvent, state) => {
					if (state === 'interrupted') {
						console.log('Download is interrupted but can be resumed');
					} else if (state === 'progressing') {
						if (item.isPaused()) {
							console.log('Download is paused');
						} else {
							console.log(`Received bytes: ${item.getReceivedBytes()}`);
						}
					}
				});
				item.once('done', (doneEvent, state) => {
					if (state === 'completed') {
						event.reply('manual-mod', mod, 'done');
						console.log('Download successfully');
					} else {
						console.log(`Download failed: ${state}`);
					}
				});
				
				// Close the window
				window.close();
			});
			
			// Emitted when the window is closed.
			window.on('closed', () => {
				// Dereference the window object, usually you would store windows
				// in an array if your app supports multi windows, this is the time
				// when you should delete the corresponding element.
				windows.splice(windows.indexOf(window), 1);
			});

			windows.push(window);
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
