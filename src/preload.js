const _ = require('./script/lib.js');
const fs = require('fs');
const path = require('path');
const del = require('del');
const slash = require('slash');
const request = require('request');
const progress = require('request-progress');
const os = require('os');
const childProcess = require('child_process');
const {ipcRenderer, shell} = require('electron');

const DOWNLOAD_SLOTS = 3;
let isBusy = false;

const Directory = {};
Directory.SELF = __dirname;
Directory.PACKS = path.join(Directory.SELF, 'packs');

async function updateProfile(installDirectory, packDirectory, packData) {
	let totalMem = os.totalmem() / 2 ** 30;
	let configuredMem = packData.ram.minimum;
	
	if (totalMem > packData.ram.maximum + 2) {
		configuredMem = packData.ram.maximum;
	} else if (totalMem > packData.ram.preferred + 1) {
		configuredMem = packData.ram.preferred;
	}
	
	await fs.promises.readFile(path.join(installDirectory, 'launcher_profiles.json'), {encoding: 'utf8'}).then((data) => {
		data = JSON.parse(data);
		
		data.profiles[packData.id] = {
			gameDir: packDirectory,
			icon: packData.profile.icon,
			javaArgs: `-Xmx${configuredMem}G -XX:+UnlockExperimentalVMOptions -XX:+UseG1GC -XX:G1NewSizePercent=20 -XX:G1ReservePercent=20 -XX:MaxGCPauseMillis=50 -XX:G1HeapRegionSize=32M -Dfml.readTimeout=120 -Dfml.loginTimeout=120`,
			lastUsed: new Date(Date.now() + 1000 * 60 * 5).toISOString(),
			lastVersionId: `${packData.version.minecraft}-forge${packData.version.forge}`,
			name: packData.name,
			type: 'custom'
		};
		
		return JSON.stringify(data, null, 2);
	}).then(async (data) => {
		await fs.promises.writeFile(path.join(installDirectory, 'launcher_profiles.json'), data);
	});
}

function downloadFile(url, destinationDirectory, infoCallback, progressCallback) {
	let infoCalled = false;
	
	return new Promise(async (resolve) => {
		while (true) {
			try {
				progressCallback({percent: null});
				let promise = new Promise((attemptResolve, reject) => {
					let fileRequest = progress(request(url), {throttle: 50}).on('progress', (state) => {
						if (progressCallback) {
							progressCallback(state);
						}
					}).on('error', (error) => {
						console.log('Network error', url);
						reject();
					}).on('response', (response) => {
						if (response.statusCode !== 200) {
							console.log('Non 200 status code', url);
							reject();

							return;
						}

						let fileName = path.parse(fileRequest.uri.href).base;
						let downloadPath = path.join(destinationDirectory, fileName);
						
						if (!infoCalled && infoCallback) {
							infoCallback(fileRequest, fileName);
						}

						console.log(`Receiving ${url}`);
						fileRequest.pipe(fs.createWriteStream(downloadPath)).on('finish', () => {
							attemptResolve(fileName);
						}).on('error', (error) => {
							console.log('Pipe error', url);
							reject();
						});
					});
				});
				let fileName = await promise;
				resolve(fileName);
				break;
			} catch (error) {
				// Do nothing
			}
		}
	});
}

function filterMods(type, packData) {
	let filteredMods = new Map();
	let manualMods = [];
	
	for (let [id, mod] of packData.mods) {
		if (mod.target === type || mod.target === 'both') {
			if (mod.manual) {
				manualMods.push(mod);
			} else {
				filteredMods.set(id, mod);
			}
		}
	}
	
	return {automatic: filteredMods, manual: manualMods};
}

function downloadMods(type, mods, modsDirectory, downloadDirectory, progressElement) {
	let modKeys = Array.from(mods.keys());
	let nextIndex = 0;
	let downloadProgress = 0;
	let progressElements = [];
	let fileMap = new Map();
	
	progressElement.message = `Downloading mods... (0 of ${mods.size} complete)`;
	
	return new Promise((resolve) => {
		function downloadMod(mod, modProgressElement) {
			return new Promise((modResolve) => {
				let aborted = false;
				
				modProgressElement.message = `Verifying ${mod.name}... (0%)`;
				modProgressElement.value = null;
				downloadFile(mod.url, downloadDirectory, (fileRequest, fileName) => {
					fileMap.set(mod.id, fileName);
					// Don't download if the mod is already installed locally
					if (fs.existsSync(path.join(modsDirectory, fileName))) {
						aborted = true;
						fileRequest.abort();
					}
				}, (state) => {
					modProgressElement.message = `${state.percent === null ? 'Verifying' : 'Downloading'} ${mod.name}... (${(state.percent * 100).toFixed()}%)`;
					modProgressElement.value = state.percent;
				}).then(async (fileName) => {
					if (!aborted) {
						let downloadPath = path.join(downloadDirectory, fileName);
						let destinationPath = path.join(modsDirectory, fileName);
						await fs.promises.rename(downloadPath, destinationPath);
					}
					progressElement.value = ++downloadProgress / mods.size;
					progressElement.message = `Downloading mods... (${downloadProgress} of ${mods.size} complete)`;
					
					if (downloadProgress == mods.size) {
						resolve(fileMap);
					}
					
					modResolve();
				});
			});
		}
		
		for (let i = 0; i < DOWNLOAD_SLOTS; i++) {
			let modProgressElement = progressElement.addProgress();
			progressElements.push(modProgressElement);
			
			(async () => {
				while (nextIndex < mods.size) {
					let mod = null;
					
					if (nextIndex < mods.size) {
						mod = mods.get(modKeys[nextIndex++]);
					}
					
					if (mod === null) {
						return;
					} else {
						console.log(`Slot ${i}: Downloading ${mod.name}`);
						await downloadMod(mod, modProgressElement);
					}
				}
				
				modProgressElement.remove();
			})();
		}
	});
}

function getJSON(url) {
	return new Promise((resolve, reject) => {
		request(url, {json: true}, (error, response, data) => {
			if (error) {
				reject(error);
			}

			resolve(data);
		});
	});
}

window.addEventListener('DOMContentLoaded', async () => {
	let baseDirectory = process.env.APPDATA || (process.platform == 'darwin' ? path.join(process.env.HOME, 'Library', 'Application Support') : path.join(process.env.HOME, '.local', 'share'));
	let installDirectory = path.join(baseDirectory, `${(process.platform == 'win32' ? '.' : '')}minecraft`);
	
	let clientInstallCheck = document.getElementById('client-install-check');
	let serverInstallCheck = document.getElementById('server-install-check');
	let packSelectElement = document.getElementById('pack-select');
	let packNameElement = document.getElementById('pack-name');
	let packAboutElement = document.getElementById('pack-about');
	let packDescriptionElement = document.getElementById('pack-description');
	let packMCVersionElement = document.getElementById('pack-minecraft-version');
	let packClientInstallElement = document.getElementById('pack-install-client');
	let packServerInstallElement = document.getElementById('pack-install-server');
	let progressGroupElement = document.getElementById('progress');
	let progressElement = document.getElementById('progress-main');
	let toggleAdvancedElement = document.getElementById('advanced-toggle');
	let advancedSettingsElement = document.getElementById('advanced-settings');
	let installDirElement = document.getElementById('install-dir');
	let installDirChangeElement = document.getElementById('install-change');
	let versionElement = document.getElementById('version');
	let debugElement = document.getElementById('debug');
	
	let advancedShown = false;
	let selectedPackElement = null;
	let selectedPack = null;
	let packs;
	
	// Display the version
	versionElement.innerText = `v${ipcRenderer.sendSync('version')}`;
	
	async function validateInstallDirectory() {
		let value = {};
		
		await fs.promises.readFile(path.join(installDirectory, 'launcher_profiles.json'), {encoding: 'utf8'}).then((data) => {
			try {
				data = JSON.parse(data);
				value.valid = true;
				
				if (selectedPack !== null) {
					let packData = packs.get(selectedPack);
					if (data.profiles.forge && data.profiles.forge.lastVersionId == `${packData.version.minecraft}-forge${packData.version.forge}`) {
						value.forgeInstalled = true;
					} else {
						value.forgeInstalled = false;
					}
				}
			} catch (error) {
				value.valid = false;
			}
		}).catch((error) => {
			value.valid = false;
		});
		
		return value;
	}
	
	async function checkInstallDirectory() {
		let data = await validateInstallDirectory();
		
		while (clientInstallCheck.lastChild) {
			clientInstallCheck.removeChild(clientInstallCheck.lastChild);
		}
		while (serverInstallCheck.lastChild) {
			serverInstallCheck.removeChild(serverInstallCheck.lastChild);
		}
		
		// Client checks
		if (data.valid) {
			_.createHTML(`<div class='row'><span class='material-icons icon'>check_circle</span>Minecraft is installed.</div>`, clientInstallCheck);
		} else {
			_.createHTML(`<div class='row'><span class='material-icons icon'>cancel</span>Minecraft is not installed. Run the Minecraft launcher first!</div>`, clientInstallCheck);
		}
		if (selectedPack !== null) {
			if (data.forgeInstalled) {
				_.createHTML(`<div class='row'><span class='material-icons icon'>check_circle</span>Forge is installed.</div>`, clientInstallCheck);
			} else {
				_.createHTML(`<div class='row'><span class='material-icons icon'>cancel</span>Forge is not installed. Will be installed automatically.</div>`, clientInstallCheck);
			}
		}
		// Server checks
		_.createHTML(`<div class='row'><span class='material-icons icon'>check_circle</span>No prerequisites.</div>`, serverInstallCheck);
	}
	
	function showPackInfo(packData) {
		packAboutElement.style.display = '';
		packNameElement.innerText = packData.name;
		packDescriptionElement.innerText = packData.description;
		packMCVersionElement.innerText = packData.version.minecraft;
	}
	
	function toggleAdvancedSettings(shouldShow) {
		advancedShown = shouldShow !== undefined ? shouldShow : !advancedShown;
		
		if (advancedShown) {
			toggleAdvancedElement.querySelector('.mdc-button__label').innerText = 'Hide Advanced Settings';
			toggleAdvancedElement.querySelector('.mdc-button__icon').innerText = 'keyboard_arrow_up';
			advancedSettingsElement.style.display = '';
		} else {
			toggleAdvancedElement.querySelector('.mdc-button__label').innerText = 'Show Advanced Settings';
			toggleAdvancedElement.querySelector('.mdc-button__icon').innerText = 'keyboard_arrow_down';
			advancedSettingsElement.style.display = 'none';
		}
	}
	
	while (true) {
		try {
			packs = await getJSON('https://raw.githubusercontent.com/Smiley43210/RedPack/master/packs/index.json');
			break;
		} catch (error) {
			// Do nothing
		}
	}
	
	// Convert packs to Map and populate pack list
	{
		let newPacks = new Map();
		for (let pack of packs) {
			let packData = await getJSON(`https://raw.githubusercontent.com/Smiley43210/RedPack/master/packs/${pack}.json`);
			packData.id = pack;
			
			// Convert mods object to a Map
			let newMods = new Map();
			for (let mod in packData.mods) {
				if (packData.mods.hasOwnProperty(mod)) {
					let modObject = packData.mods[mod];
					modObject.id = mod;
					newMods.set(mod, modObject);
				}
			}
			packData.mods = newMods;
			
			newPacks.set(pack, packData);
			
			let packItem = _.createHTML(`<div class='item'><div class='title'>${packData.name}</div><div class='version'>Minecraft ${packData.version.minecraft}</div></div>`, packSelectElement);

			packItem.addEventListener('click', () => {
				if (isBusy) {
					return;
				}
				
				if (selectedPackElement) {
					selectedPackElement.classList.remove('selected');
				}

				packItem.classList.add('selected');
				selectedPackElement = packItem;
				selectedPack = pack;
				
				showPackInfo(packData);

				packClientInstallElement.removeAttribute('disabled');
				packServerInstallElement.removeAttribute('disabled');
				
				checkInstallDirectory();
			});
		}
		packs = newPacks;
	}
	
	packNameElement.innerText = 'Select a Modpack';
	
	// Show install directory
	installDirElement.innerText = installDirectory;
	await checkInstallDirectory();
	
	packClientInstallElement.addEventListener('click', async () => {
		if (selectedPack === null) {
			return;
		}
		
		isBusy = true;
		toggleAdvancedSettings(false);
		packClientInstallElement.setAttribute('disabled', '');
		packServerInstallElement.setAttribute('disabled', '');
		packClientInstallElement.innerText = 'Installing Client...';
		
		let packData = packs.get(selectedPack);
		let packDirectory = path.join(installDirectory, 'modpack', packData.id);
		let modsDirectory = path.join(packDirectory, 'mods');
		let downloadDirectory = path.join(modsDirectory, 'downloading');
		
		// Create subdirectory
		fs.promises.mkdir(downloadDirectory, {recursive: true});
		
		progressGroupElement.style.display = '';
		
		// Validate install directory
		let validityData = await validateInstallDirectory();
		
		if (!validityData.forgeInstalled) {
			// Download and install forge
			progressElement.message = 'Downloading Minecraft Forge...';
			await downloadFile(`https://files.minecraftforge.net/maven/net/minecraftforge/forge/${packData.version.forge}/forge-${packData.version.forge}-installer${process.platform == 'win32' ? '-win.exe' : '.jar'}`, downloadDirectory, null, (state) => {
				progressElement.message = `Downloading Minecraft Forge... (${(state.percent * 100).toFixed()}%)`;
				progressElement.value = state.percent;
			}).then(async (fileName) => {
				let filePath = path.join(downloadDirectory, fileName);
				
				progressElement.value = null;
				progressElement.message = '<div>Installing Minecraft Forge...</div><div>An installer will appear. Choose "Install client" and follow the prompts.</div>';
				while (true) {
					try {
						await new Promise((resolve, reject) => {
							if (process.platform == 'win32') {
								childProcess.execFile(filePath, (error) => {
									if (error) {
										reject(error);
									} else {
										resolve();
									}
								});
							} else {
								childProcess.exec(`/usr/bin/java -jar "${filePath}"`, (error) => {
									if (error) {
										reject(error);
									} else {
										resolve();
									}
								});
							}
						});
						break;
					} catch (error) {
						console.log('Error installing Minecraft Forge');
					}
				}
			});
		}
		
		progressElement.message = 'Modifying profile...';
		
		// Modify profile
		updateProfile(installDirectory, packDirectory, packData);
		
		// Import options
		if (!fs.existsSync(path.join(packDirectory, 'options.txt'))) {
			await fs.promises.copyFile(path.join(installDirectory, 'options.txt'), path.join(packDirectory, 'options.txt'));
		}
		
		// Separate manual mods
		let filteredMods = filterMods('client', packData);
		
		// Download mods
		let downloadMap = await downloadMods('client', filteredMods.automatic, modsDirectory, downloadDirectory, progressElement);
		progressElement.message = 'Modpack installation complete!';
		
		// Cleanup mods
		// FIXME: Will not work for manual mods like 'mekanism' and 'mekanism-generators'
		let files = fs.readdirSync(modsDirectory);
		let mappedFiles = Array.from(downloadMap.values());
		let installedManualMods = [];
		for (let file of files) {
			if (mappedFiles.indexOf(file) == -1) {
				let found = false;
				
				for (let mod of filteredMods.manual) {
					if (file.toLocaleLowerCase().indexOf(mod.id.toLocaleLowerCase()) > -1) {
						found = true;
						installedManualMods.push(mod.id);
						break;
					}
				}
				
				if (!found) {
					console.log(`File ${file} not part of modpack`);
					await del(slash(path.join(modsDirectory, file)), {force: true});
				}
			}
		}
		
		// Show manual mods
		if (filteredMods.manual.length > installedManualMods.length) {
			let message = _.createHTML(`<div><div>ATTENTION</div><div>${filteredMods.manual.length - installedManualMods.length} mod${filteredMods.manual.length - installedManualMods.length > 1 ? 's' : ''} must be downloaded manually. Click on each of the links below, download the mod, and place the jar file into the mods folder.</div><button class='mdc-button mdc-button--raised' style='margin: 10px 0;'><span class='mdc-button__label'>Open Mods Folder</span></button></div>`, progressGroupElement);
			message.querySelector('button').addEventListener('click', () => {
				ipcRenderer.send('show-folder', `${modsDirectory}${path.sep}`);
			});
			for (let mod of filteredMods.manual) {
				if (installedManualMods.indexOf(mod.id) == -1) {
					_.createHTML(`<div><a href="${mod.url}">${mod.name}</a></div>`, progressGroupElement);
				}
			}
		}
		
		// Delete temporary download directory
		await del(slash(path.join(downloadDirectory, '**')), {force: true});
		
		packClientInstallElement.removeAttribute('disabled');
		packServerInstallElement.removeAttribute('disabled');
		packClientInstallElement.innerText = 'Install Client';
		isBusy = false;
	});
	
	packServerInstallElement.addEventListener('click', async () => {
		if (selectedPack === null) {
			return;
		}
		
		isBusy = true;
		toggleAdvancedSettings(false);
		packClientInstallElement.setAttribute('disabled', '');
		packServerInstallElement.setAttribute('disabled', '');
		packServerInstallElement.innerText = 'Installing Server...';
		
		let packData = packs.get(selectedPack);
		let modsDirectory = path.join(installDirectory, 'mods');
		let downloadDirectory = path.join(modsDirectory, 'downloading');
		
		// Create subdirectory
		fs.promises.mkdir(downloadDirectory, {recursive: true});
		
		progressGroupElement.style.display = '';
		
		// Separate manual mods
		let filteredMods = filterMods('server', packData);
		
		// Download mods
		let downloadMap = await downloadMods('server', filteredMods.automatic, modsDirectory, downloadDirectory, progressElement);
		progressElement.message = 'Modpack installation complete!';
		
		// Cleanup mods
		// FIXME: Will not work for manual mods like 'mekanism' and 'mekanism-generators'
		let files = fs.readdirSync(modsDirectory);
		let mappedFiles = Array.from(downloadMap.values());
		let installedManualMods = [];
		for (let file of files) {
			if (mappedFiles.indexOf(file) == -1) {
				let found = false;
				
				for (let mod of filteredMods.manual) {
					if (file.toLocaleLowerCase().indexOf(mod.id.toLocaleLowerCase()) > -1) {
						found = true;
						installedManualMods.push(mod.id);
						break;
					}
				}
				
				if (!found) {
					console.log(`File ${file} not part of modpack`);
					await del(slash(path.join(modsDirectory, file)), {force: true});
				}
			}
		}
		
		// Show manual mods
		if (filteredMods.manual.length > installedManualMods.length) {
			let message = _.createHTML(`<div><div>ATTENTION</div><div>${filteredMods.manual.length - installedManualMods.length} mod${filteredMods.manual.length - installedManualMods.length > 1 ? 's' : ''} must be downloaded manually. Click on each of the links below, download the mod, and place the jar file into the mods folder.</div><button class='mdc-button mdc-button--raised' style='margin: 10px 0;'><span class='mdc-button__label'>Open Mods Folder</span></button></div>`, progressGroupElement);
			message.querySelector('button').addEventListener('click', () => {
				ipcRenderer.send('show-folder', `${modsDirectory}${path.sep}`);
			});
			for (let mod of filteredMods.manual) {
				if (installedManualMods.indexOf(mod.id) == -1) {
					_.createHTML(`<div><a href="${mod.url}">${mod.name}</a></div>`, progressGroupElement);
				}
			}
		}
		
		// Delete temporary download directory
		await del(slash(path.join(downloadDirectory, '**')), {force: true});
		
		packClientInstallElement.removeAttribute('disabled');
		packServerInstallElement.removeAttribute('disabled');
		packServerInstallElement.innerText = 'Install Server';
		isBusy = false;
	});
	
	toggleAdvancedElement.addEventListener('click', () => {
		toggleAdvancedSettings();
	});
	
	installDirChangeElement.addEventListener('click', async () => {
		let paths = ipcRenderer.sendSync('folder-select', installDirectory);
		
		if (paths) {
			installDirectory = paths[0];
			installDirElement.innerText = paths[0];
			await checkInstallDirectory();
		}
	});
	
	debugElement.addEventListener('click', () => {
		ipcRenderer.send('open-devtools');
	});
	
	// Open all links in external browser
	document.addEventListener('click', (event) => {
		if (event.target.tagName === 'A' && event.target.href.startsWith('http')) {
			event.preventDefault();
			shell.openExternal(event.target.href);
		}
	});
});

const _setImmediate = setImmediate;
process.once('loaded', () => {
	global.setImmediate = _setImmediate;
});
