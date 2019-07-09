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
		
		data.profiles.treeline = {
			gameDir: packDirectory,
			icon: packData.profile.icon,
			javaArgs: `-Xmx${configuredMem}G -XX:+UnlockExperimentalVMOptions -XX:+UseG1GC -XX:G1NewSizePercent=20 -XX:G1ReservePercent=20 -XX:MaxGCPauseMillis=50 -XX:G1HeapRegionSize=32M -Dfml.readTimeout=120 -Dfml.loginTimeout=120`,
			lastUsed: new Date(Date.now() + 1000 * 60 * 5).toISOString(),
			lastVersionId: `${packData.minecraftVersion}-forge${packData.forgeVersion}`,
			name: packData.name,
			type: 'custom'
		};
		
		return JSON.stringify(data, null, 2);
	}).then(async (data) => {
		await fs.promises.writeFile(path.join(installDirectory, 'launcher_profiles.json'), data);
	});
}

function downloadFile(url, destinationDirectory, progressCallback) {
	return new Promise((resolve, reject) => {
		let fileRequest = progress(request(url), {throttle: 100}).on('progress', (state) => {
			if (progressCallback) {
				progressCallback(state);
			}
		}).on('error', (error) => {
			console.log('Network error');
			reject();
		}).on('response', (response) => {
			if (response.statusCode !== 200) {
				console.log('Non 200 status code');
				reject();
				
				return;
			}

			let fileName = path.parse(fileRequest.uri.href).base;
			let downloadPath = path.join(destinationDirectory, fileName);

			console.log(`Downloading ${url}`);
			fileRequest.pipe(fs.createWriteStream(downloadPath)).on('finish', () => {
				resolve(fileName);
			}).on('error', (error) => {
				console.log("Pipe error");
				reject();
			});
		});
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
	
	progressElement.message = `Downloading mods... (0 of ${mods.size} complete)`;
	
	return new Promise((resolve) => {
		function cleanup() {
			for (let modProgressElement of progressElements) {
				modProgressElement.remove();
			}
		}
		
		function downloadMod(mod, modProgressElement) {
			return new Promise((modResolve) => {
				modProgressElement.message = `Downloading ${mod.name}... (0%)`;
				modProgressElement.value = null;
				downloadFile(mod.url, downloadDirectory, (state) => {
					modProgressElement.message = `Downloading ${mod.name}... (${(state.percent * 100).toFixed()}%)`;
					modProgressElement.value = state.percent;
				}).then(async (fileName) => {
					let downloadPath = path.join(downloadDirectory, fileName);
					let destinationPath = path.join(modsDirectory, fileName);
					await fs.promises.rename(downloadPath, destinationPath);
					progressElement.value = ++downloadProgress / mods.size;
					progressElement.message = `Downloading mods... (${downloadProgress} of ${mods.size} complete)`;
					if (downloadProgress == mods.size) {
						cleanup();
						resolve();
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
			})();
		}
	});
}

function getJSON(url) {
	return new Promise((resolve, reject) => {
		request(url, { json: true }, (error, response, data) => {
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
	
	let installDirElement = document.getElementById('install-dir');
	let installDirChangeElement = document.getElementById('install-change');
	let packSelectElement = document.getElementById('pack-select');
	let packNameElement = document.getElementById('pack-name');
	let packClientInstallElement = document.getElementById('pack-install-client');
	let packServerInstallElement = document.getElementById('pack-install-server');
	let progressGroupElement = document.getElementById('progress');
	let progressElement = document.getElementById('progress-main');
//	let packs = JSON.parse(await fs.promises.readFile(path.join(Directory.PACKS, 'index.json')));
	let packs = await getJSON('https://raw.githubusercontent.com/Smiley43210/mc-mod-tool/master/packs/index.json');
	
	let selectedPackElement = null;
	let selectedPack = null;
	
	// Convert packs to Map and populate pack list
	{
		let newPacks = new Map();
		for (let pack of packs) {
			let packData = await getJSON(`https://raw.githubusercontent.com/Smiley43210/mc-mod-tool/master/packs/${pack}.json`);
//			let packData = JSON.parse(await fs.promises.readFile(path.join(Directory.PACKS, `${pack}.json`), {encoding: 'utf8'}));
			
			// Convert mods object to a Map
			let newMods = new Map();
			for (let mod in packData.mods) {
				if (packData.mods.hasOwnProperty(mod)) {
					newMods.set(mod, packData.mods[mod]);
				}
			}
			packData.mods = newMods;
			
			newPacks.set(pack, packData);
			
			let packItem = _.createHTML(`<div class='item'><div class='title'>${packData.name}</div><div class='version'>Minecraft ${packData.minecraftVersion}</div></div>`, packSelectElement);

			packItem.addEventListener('click', () => {
				if (selectedPackElement) {
					selectedPackElement.classList.remove('selected');
				}

				packItem.classList.add('selected');
				selectedPackElement = packItem;
				selectedPack = pack;

				packNameElement.innerText = packData.name;
				packClientInstallElement.removeAttribute('disabled');
				packServerInstallElement.removeAttribute('disabled');
			});
		}
		packs = newPacks;
	}
	console.log(packs);
	
	packNameElement.innerText = 'Select a Modpack';
	
	// Show install directory
	installDirElement.innerText = installDirectory;
	
	packClientInstallElement.addEventListener('click', async () => {
		if (selectedPack === null) {
			return;
		}
		
		packClientInstallElement.setAttribute('disabled', '');
		packClientInstallElement.innerText = 'Installing Client Pack...';
		
		let packData = packs.get(selectedPack);
		let packDirectory = path.join(installDirectory, 'modpack', packData.name);
		let modsDirectory = path.join(packDirectory, 'mods');
		let downloadDirectory = path.join(modsDirectory, 'downloading');
		
		// Empty mods directory
		await del(slash(path.join(modsDirectory, '**')), {force: true});
		
		// Create subdirectory
		fs.promises.mkdir(downloadDirectory, {recursive: true});
		
		progressGroupElement.style.display = '';
		
		// Download and install forge
		progressElement.message = 'Downloading Minecraft Forge...';
		await downloadFile(`https://files.minecraftforge.net/maven/net/minecraftforge/forge/${packData.forgeVersion}/forge-${packData.forgeVersion}-installer${process.platform == 'win32' ? '-win.exe' : '.jar'}`, downloadDirectory, (state) => {
			progressElement.message = `Downloading Minecraft Forge... (${(state.percent * 100).toFixed()}%)`;
			progressElement.value = state.percent;
		}).then((fileName) => {
			return new Promise((resolve, reject) => {
				let filePath = path.join(downloadDirectory, fileName);
				
				progressElement.value = null;
				progressElement.message = '<div>Installing Minecraft Forge...</div><div>An installer will appear. Choose "Install client" and follow the prompts.</div>';
				if (process.platform == 'win32') {
					childProcess.execFile(filePath, (error) => {
						if (error) {
							console.log('Error installing Minecraft Forge');
							reject(error);
						} else {
							resolve();
						}
					});
				} else {
					childProcess.exec(`/usr/bin/java -jar "${filePath}"`, (error) => {
						if (error) {
							console.log('Error installing Minecraft Forge');
							reject(error);
						} else {
							resolve();
						}
					});
				}
			});
		});
		
		progressElement.message = 'Modifying profile...';
		
		// Modify profile
		updateProfile(installDirectory, packDirectory, packData);
		
		// Import options
		await fs.promises.copyFile(path.join(installDirectory, 'options.txt'), path.join(packDirectory, 'options.txt'));
		// Separate manual mods
		let filteredMods = filterMods('client', packData);
		// Download mods
		await downloadMods('client', filteredMods.automatic, modsDirectory, downloadDirectory, progressElement);
		progressElement.message = 'Modpack installation complete!';
		// Show manual mods
		for (let mod of filteredMods.manual) {
			_.createHTML(`<div>ATTENTION: Manual mod download required: <a href="${mod.url}">${mod.name}</a></div>`, progressGroupElement);
		}
		
		// Delete temporary download directory
		await del(slash(path.join(downloadDirectory, '**')), {force: true});
		
		packClientInstallElement.removeAttribute('disabled');
		packClientInstallElement.innerText = 'Install Pack for Client';
	});
	
	packServerInstallElement.addEventListener('click', async () => {
		if (selectedPack === null) {
			return;
		}
		
		packServerInstallElement.setAttribute('disabled', '');
		packServerInstallElement.innerText = 'Installing Server Pack...';
		
		let packData = packs.get(selectedPack);
		let modsDirectory = path.join(installDirectory, 'mods');
		let downloadDirectory = path.join(modsDirectory, 'downloading');
		
		// Empty mods directory
		await del(slash(path.join(modsDirectory, '**')), {force: true});
		
		// Create subdirectory
		fs.promises.mkdir(downloadDirectory, {recursive: true});
		
		progressGroupElement.style.display = '';
		
		// Separate manual mods
		let filteredMods = filterMods('server', packData);
		// Download mods
		await downloadMods('server', filteredMods.automatic, modsDirectory, downloadDirectory, progressElement);
		progressElement.message = 'Modpack installation complete!';
		// Show manual mods
		for (let mod of filteredMods.manual) {
			_.createHTML(`<div>ATTENTION: Manual mod download required: <a href="${mod.url}">${mod.name}</a></div>`, progressGroupElement);
		}
		
		// Delete temporary download directory
		await del(slash(path.join(downloadDirectory, '**')), {force: true});
		
		packServerInstallElement.removeAttribute('disabled');
		packServerInstallElement.innerText = 'Install Pack for Server';
	});
	
	installDirChangeElement.addEventListener('click', () => {
		let paths = ipcRenderer.sendSync('folder-select', installDirectory);
		
		if (paths) {
			installDirectory = paths[0];
			installDirElement.innerText = paths[0];
		}
	});
	
	// Open all links in external browser
	document.addEventListener('click', (event) => {
		if (event.target.tagName === 'A' && event.target.href.startsWith('http')) {
			event.preventDefault();
			shell.openExternal(event.target.href);
		}
	})
});

const _setImmediate = setImmediate;
process.once('loaded', () => {
	global.setImmediate = _setImmediate;
});
