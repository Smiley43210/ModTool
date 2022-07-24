/* global mdc */

const _ = require('./script/lib.js');
const fs = require('fs');
const fsPromise = require('fs/promises');
const timers = require('timers/promises');
const path = require('path');
const glob = require('glob');
const del = require('del');
const slash = require('slash');
const progress = require('./util/progress.js');
const os = require('os');
const childProcess = require('child_process');
const {ipcRenderer} = require('electron');

const DOWNLOAD_SLOTS = 3;
let isBusy = false;

async function updateProfile(installDirectory, packDirectory, packData) {
	const totalMem = os.totalmem() / 2 ** 30;
	let configuredMem = packData.ram.minimum;
	
	if (totalMem > packData.ram.maximum + 2) {
		configuredMem = packData.ram.maximum;
	} else if (totalMem > packData.ram.preferred + 1) {
		configuredMem = packData.ram.preferred;
	}
	
	const data = JSON.parse(await fs.promises.readFile(path.join(installDirectory, 'launcher_profiles.json'), {encoding: 'utf8'}));
	data.profiles[packData.id] = {
		gameDir: packDirectory,
		icon: packData.profile.icon,
		javaArgs: `-Xmx${configuredMem}G -XX:+UnlockExperimentalVMOptions -XX:+UseG1GC -XX:G1NewSizePercent=20 -XX:G1ReservePercent=20 -XX:MaxGCPauseMillis=50 -XX:G1HeapRegionSize=32M -Dfml.readTimeout=120 -Dfml.loginTimeout=120`,
		lastUsed: new Date(Date.now() + 1000 * 60 * 5).toISOString(),
		lastVersionId: packData.installation.forge,
		name: packData.name,
		type: 'custom',
	};
	await fs.promises.writeFile(path.join(installDirectory, 'launcher_profiles.json'), JSON.stringify(data, null, 2));
}

async function downloadFile(url, destinationDirectory, setInfo, setProgress) {
	let retriesLeft = 3;
	
	while (retriesLeft > 0) {
		try {
			setProgress({percent: null});
			const abortController = new AbortController();
			const response = await fetch(url, {signal: abortController.signal});
			console.log(`Receiving ${response.url}`);
			
			if (response.status !== 200) {
				console.error('Non 200 status code', url);
				throw new Error(`Non 200 status code for ${url}`);
			}
			
			const fileName = path.parse(response.url).base;
			const downloadPath = path.join(destinationDirectory, fileName);
			if (setInfo) {
				setInfo(fileName, abortController);
			}
			
			const buffer = await progress(response, setProgress);
			fsPromise.writeFile(downloadPath, buffer);
			
			return fileName;
		} catch (error) {
			// Ignore aborts
			if (error.name === 'AbortError') {
				break;
			}
			
			console.warn(error);
			await timers.setTimeout(500);
			retriesLeft--;
		}
	}
	
	if (retriesLeft == 0) {
		showSnackbar('Failed to download file! See console for details', 10000);
	}
}

function filterMods(target, packData) {
	const filteredMods = new Map();
	const manualMods = [];
	
	for (const [id, mod] of packData.mods) {
		if (mod.target === target || mod.target === 'both') {
			if (mod.manual) {
				manualMods.push(mod);
			} else {
				filteredMods.set(id, mod);
			}
		}
	}
	
	return {automatic: filteredMods, manual: manualMods};
}

function downloadMods(target, mods, modsDirectory, downloadDirectory, progressElement) {
	const modKeys = Array.from(mods.keys());
	let nextIndex = 0;
	let downloadProgress = 0;
	const progressElements = [];
	const fileMap = new Map();
	
	progressElement.message = `Downloading mods... (0 of ${mods.size} complete)`;
	
	return new Promise((resolve) => {
		function downloadMod(mod, modProgressElement) {
			return new Promise((modResolve) => {
				let aborted = false;
				
				modProgressElement.message = `Verifying ${mod.name}... (0%)`;
				modProgressElement.value = null;
				downloadFile(mod.url, downloadDirectory, (fileName, abortController) => {
					fileMap.set(mod.id, fileName);
					// Don't download if the mod is already installed locally
					if (fs.existsSync(path.join(modsDirectory, fileName))) {
						aborted = true;
						abortController.abort();
					}
				}, ({percent}) => {
					modProgressElement.message = `${percent === null ? 'Verifying' : 'Downloading'} ${mod.name}... (${(percent * 100).toFixed()}%)`;
					modProgressElement.value = percent;
				}).then(async (fileName) => {
					if (!aborted) {
						const downloadPath = path.join(downloadDirectory, fileName);
						const destinationPath = path.join(modsDirectory, fileName);
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
			const modProgressElement = progressElement.addProgress();
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

async function getJSON(url) {
	const response = await fetch(url, {cache: 'no-cache'});
	return await response.json();
}

function showSnackbar(message, timeout = 5000, button = {}) {
	const snackbarElement = _.createHTML(`<div class='mdc-snackbar mdc-snackbar--leading'><div class='mdc-snackbar__surface'><div class='mdc-snackbar__label' role='status' aria-live='polite'>${message}</div><div class='mdc-snackbar__actions'></div></div></div>`, document.body);
	
	if (button.actionText) {
		_.createHTML(`<button type='button' class='mdc-button mdc-snackbar__action'><div class='mdc-button__ripple'></div><span class='mdc-button__label'>${button.actionText}</span></button>`, snackbarElement.querySelector('.mdc-snackbar__actions'));
	}
	if (button.dismiss) {
		_.createHTML("<button class='mdc-icon-button mdc-snackbar__dismiss material-icons' title='Dismiss'>close</button>", snackbarElement.querySelector('.mdc-snackbar__actions'));
	}
	
	const snackbar = new mdc.snackbar.MDCSnackbar(snackbarElement);
	snackbar.timeoutMs = timeout;
	snackbar.listen('MDCSnackbar:closing', (event) => {
		if (event.detail.reason == 'action') {
			button.action();
		}
	});
	snackbar.listen('MDCSnackbar:closed', (event) => {
		snackbarElement.parentElement.removeChild(snackbarElement);
	});
	
	snackbar.open();
	
	return snackbar;
}

window.addEventListener('DOMContentLoaded', async () => {
	const baseDirectory = process.env.APPDATA || (process.platform == 'darwin' ? path.join(process.env.HOME, 'Library', 'Application Support') : path.join(process.env.HOME, '.local', 'share'));
	let installDirectory = path.join(baseDirectory, `${process.platform == 'win32' ? '.' : ''}minecraft`);
	let runtimeDirectory = null;
	
	if (process.platform == 'win32') {
		const drives = await new Promise((resolve, reject) => {
			childProcess.exec('wmic logicaldisk get name', (error, stdout, stderr) => {
				if (error) {
					reject(error);
					
					return;
				}
				
				const entries = stdout.trim().split(/[\r\n]+/).map((entry) => {
					return `${entry.trim()}\\`;
				});
				// Remove "Name" label
				entries.shift();
				
				resolve(entries);
			});
		});
		
		// Check each drive for java runtime
		for (const drive of drives) {
			const testPath = path.join(drive, 'Program Files (x86)', 'Minecraft Launcher', 'runtime', '**', 'bin', 'java.exe').replace(/\\/g, '/');
			const files = await new Promise((resolve, reject) => {
				glob(testPath, (error, results) => {
					if (error) {
						reject(error);
					} else {
						resolve(results);
					}
				});
			});
			
			if (files.length > 0) {
				runtimeDirectory = path.parse(files[0]).dir;
				
				break;
			}
		}
	} else {
		runtimeDirectory = path.join(installDirectory, 'runtime', 'jre-x64', 'jre.bundle', 'Contents', 'Home', 'bin');
	}
	if (!fs.existsSync(runtimeDirectory)) {
		runtimeDirectory = null;
	}
	
	const refreshElement = document.getElementById('refresh');
	const clientInstallCheck = document.getElementById('client-install-check');
	const serverInstallCheck = document.getElementById('server-install-check');
	const packSelectElement = document.getElementById('pack-select');
	const packNameElement = document.getElementById('pack-name');
	const packAboutElement = document.getElementById('pack-about');
	const packDescriptionElement = document.getElementById('pack-description');
	const packMCVersionElement = document.getElementById('pack-minecraft-version');
	const packForgeVersionElement = document.getElementById('pack-forge-version');
	const packClientInstallElement = document.getElementById('pack-install-client');
	const packServerInstallElement = document.getElementById('pack-install-server');
	const progressGroupElement = document.getElementById('progress');
	const progressElement = document.getElementById('progress-main');
	const toggleAdvancedElement = document.getElementById('advanced-toggle');
	const advancedSettingsElement = document.getElementById('advanced-settings');
	const installDirElement = document.getElementById('install-dir');
	const installDirChangeElement = document.getElementById('install-change');
	const runtimeDirElement = document.getElementById('runtime-dir');
	const runtimeDirChangeElement = document.getElementById('runtime-change');
	const versionElement = document.getElementById('version');
	
	let advancedShown = false;
	let selectedPackElement = null;
	let selectedPack = null;
	let packs;
	
	// Display the version
	versionElement.innerText = `v${ipcRenderer.sendSync('version')}`;
	
	// Resize listener
	const resizeObserver = new ResizeObserver((entries) => {
		for (const entry of entries) {
			const scrollbarOffset = entry.target.offsetWidth - entry.target.clientWidth;
			
			versionElement.style.right = `${scrollbarOffset}px`;
		}
	});
	resizeObserver.observe(document.querySelector('.content'));
	
	// Update listener
	let updateSnackbar = null;
	ipcRenderer.on('update-check', (event, state) => {
		if (updateSnackbar) {
			updateSnackbar.close();
			updateSnackbar = null;
		}
		
		if (state == null) {
			return;
		}
		
		switch (state) {
			case 'checking':
				updateSnackbar = showSnackbar('Checking for application updates...', -1);
				break;
			case 'available':
				updateSnackbar = showSnackbar('An update is available! Downloading...', -1);
				break;
			case 'downloaded':
				updateSnackbar = showSnackbar('An update has been downloaded. Restart to update.', -1, {actionText: 'Restart', action: () => {
					ipcRenderer.send('update-restart');
				}, dismiss: true});
				break;
			case 'error':
				updateSnackbar = showSnackbar('An error occurred downloading the update.', -1, {dismiss: true});
				break;
		}
		
		updateSnackbar.listen('MDCSnackbar:closed', (event) => {
			updateSnackbar = null;
		});
	});
	ipcRenderer.send('update-check');
	
	async function validateInstallDirectory() {
		const value = {};
		
		try {
			const profileData = JSON.parse(await fs.promises.readFile(path.join(installDirectory, 'launcher_profiles.json'), {encoding: 'utf8'}));
			value.valid = true;

			if (selectedPack !== null) {
				const packData = packs.get(selectedPack);
				if (profileData.profiles.forge && profileData.profiles.forge.lastVersionId == packData.installation.forge) {
					value.forgeInstalled = true;
				} else {
					value.forgeInstalled = false;
				}
			}
		} catch (error) {
			value.valid = false;
		}
		
		return value;
	}
	
	function getJavaExecutable() {
		return path.join(runtimeDirectory, process.platform == 'win32' ? 'java.exe' : 'java');
	}
	
	async function checkPrerequisites() {
		const data = await validateInstallDirectory();
		
		while (clientInstallCheck.lastChild) {
			clientInstallCheck.removeChild(clientInstallCheck.lastChild);
		}
		while (serverInstallCheck.lastChild) {
			serverInstallCheck.removeChild(serverInstallCheck.lastChild);
		}
		
		// Check Minecraft installation
		if (data.valid) {
			_.createHTML("<div class='row'><span class='material-icons icon'>check</span>Minecraft is installed.</div>", clientInstallCheck);
		} else {
			_.createHTML("<div class='row'><span class='material-icons icon'>close</span>Minecraft is not installed. Run the Minecraft launcher first!</div>", clientInstallCheck);
		}
		// Check Java runtime
		let runtimeValid = false;
		if (runtimeDirectory) {
			if (fs.existsSync(getJavaExecutable())) {
				runtimeValid = true;
			}
		}
		if (runtimeValid) {
			_.createHTML("<div class='row'><span class='material-icons icon'>check</span>Found Java executable.</div>", clientInstallCheck);
			_.createHTML("<div class='row'><span class='material-icons icon'>check</span>Found Java executable.</div>", serverInstallCheck);
			
			if (selectedPack) {
				packClientInstallElement.removeAttribute('disabled');
				packServerInstallElement.removeAttribute('disabled');
			}
		} else {
			_.createHTML("<div class='row'><span class='material-icons icon'>close</span>Could not find Java executable. Make sure Minecraft is installed and set the runtime location in the advanced settings.</div>", clientInstallCheck);
			_.createHTML("<div class='row'><span class='material-icons icon'>close</span>Could not find Java executable. Make sure Minecraft is installed and set the runtime location in the advanced settings.</div>", serverInstallCheck);
			
			packClientInstallElement.setAttribute('disabled', '');
			packServerInstallElement.setAttribute('disabled', '');
		}
		// Check Forge installation
		if (selectedPack !== null) {
			if (data.forgeInstalled) {
				_.createHTML("<div class='row'><span class='material-icons icon'>check</span>Forge is installed.</div>", clientInstallCheck);
			} else {
				_.createHTML("<div class='row'><span class='material-icons icon'>priority_high</span>Forge is not installed. Will be installed automatically.</div>", clientInstallCheck);
			}
		}
		
		// // Server checks
		// _.createHTML(`<div class='row'><span class='material-icons icon'>check</span>No prerequisites.</div>`, serverInstallCheck);
	}
	
	async function showPackInfo(packData) {
		if (packData === null) {
			packAboutElement.style.display = 'none';
			packNameElement.innerText = '';
		} else {
			packAboutElement.style.display = '';
			packNameElement.innerText = packData.name;
			packDescriptionElement.innerText = packData.description;
			packMCVersionElement.innerText = packData.version.minecraft;
			packForgeVersionElement.innerText = packData.version.forge;
			
			// Show appropriate text on client button
			try {
				const data = JSON.parse(await fs.promises.readFile(path.join(installDirectory, 'launcher_profiles.json'), {encoding: 'utf8'}));
				if (data.profiles[packData.id]) {
					packClientInstallElement.querySelector('.mdc-button__label').innerText = 'Update Client';
				} else {
					throw new Error();
				}
			} catch (error) {
				packClientInstallElement.querySelector('.mdc-button__label').innerText = 'Install Client';
			}
		}
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
	
	async function installForge(packData, downloadDirectory, type) {
		progressElement.message = 'Downloading Minecraft Forge...';
		await downloadFile(`https://maven.minecraftforge.net/net/minecraftforge/forge/${packData.version.forge}/forge-${packData.version.forge}-installer.jar`, downloadDirectory, null, ({percent}) => {
			progressElement.message = `Downloading Minecraft Forge... (${(percent * 100).toFixed()}%)`;
			progressElement.value = percent;
		}).then(async (fileName) => {
			const filePath = path.join(downloadDirectory, fileName);

			progressElement.value = null;
			progressElement.message = `<div>Installing Minecraft Forge...</div><div>An installer will appear. Choose "Install ${type}" and follow the prompts.</div>`;
			let retries = 3;
			while (retries > 0) {
				try {
					await new Promise((resolve, reject) => {
						childProcess.exec(`"${getJavaExecutable()}" -jar "${filePath}"`, (error) => {
							if (error) {
								reject(error);
							} else {
								resolve();
							}
						});
					});
					break;
				} catch (error) {
					retries--;
					console.error('Error installing Minecraft Forge');
					console.error(error);
				}
			}
			if (retries == 0) {
				showSnackbar('Failed to install Forge! See console for details', 10000);
			}
		});
	}
	
	async function loadPacks() {
		await showPackInfo(null);
		refreshElement.classList.add('disabled');
		
		// Remove packs from list
		while (packSelectElement.children.length > 1) {
			packSelectElement.lastChild.remove();
		}
		
		while (true) {
			try {
				packs = await getJSON('https://raw.githubusercontent.com/Smiley43210/redpack-packs/main/packs/index.json');
				break;
			} catch (error) {
				// Do nothing
			}
		}
		
		// Convert packs to Map and populate pack list
		const newPacks = new Map();
		const packPromises = [];
		isBusy = true;
		for (const pack of packs) {
			const packItem = _.createHTML(`<div class='item'><div class='title'>${pack}</div><div class='version'>Loading...</div></div>`, packSelectElement);
			
			packPromises.push(getJSON(`https://raw.githubusercontent.com/Smiley43210/redpack-packs/main/packs/${pack}.json`).then((packData) => {
				packData.id = pack;
				
				packItem.children[0].innerText = packData.name;
				packItem.children[1].innerText = `Minecraft ${packData.version.minecraft}`;
				
				// Convert mods object to a Map
				const newMods = new Map();
				for (const mod in packData.mods) {
					if (packData.mods.hasOwnProperty(mod)) {
						const modObject = packData.mods[mod];
						modObject.id = mod;
						newMods.set(mod, modObject);
					}
				}
				packData.mods = newMods;
				
				newPacks.set(pack, packData);
				
				packItem.addEventListener('click', async () => {
					if (isBusy) {
						return;
					}
					
					if (selectedPackElement) {
						selectedPackElement.classList.remove('selected');
					}
					
					packItem.classList.add('selected');
					selectedPackElement = packItem;
					selectedPack = pack;
					
					await showPackInfo(packData);
					
					packClientInstallElement.removeAttribute('disabled');
					packServerInstallElement.removeAttribute('disabled');
					
					checkPrerequisites();
				});
			}));
		}
		
		await Promise.all(packPromises);
		
		refreshElement.classList.remove('disabled');
		isBusy = false;
		packs = newPacks;
		packNameElement.innerText = 'Select a Modpack';
	}
	
	refreshElement.addEventListener('click', loadPacks);
	
	await loadPacks();
	
	// Show install directory
	installDirElement.innerText = installDirectory;
	runtimeDirElement.innerHTML = runtimeDirectory ? runtimeDirectory : '<span style=\'font-style: italic;\'>Directory could not be found</span>';
	await checkPrerequisites();
	
	packClientInstallElement.addEventListener('click', async () => {
		if (selectedPack === null) {
			return;
		}
		
		isBusy = true;
		toggleAdvancedSettings(false);
		packClientInstallElement.setAttribute('disabled', '');
		packServerInstallElement.setAttribute('disabled', '');
		packClientInstallElement.innerText = 'Installing Client...';
		
		const packData = packs.get(selectedPack);
		const packDirectory = path.join(installDirectory, 'modpack', packData.id);
		const modsDirectory = path.join(packDirectory, 'mods');
		const downloadDirectory = path.join(modsDirectory, 'downloading');
		
		// Create subdirectory
		fs.promises.mkdir(downloadDirectory, {recursive: true});
		
		progressGroupElement.style.display = '';
		
		// Validate install directory
		const validityData = await validateInstallDirectory();
		
		if (!validityData.forgeInstalled) {
			// Download and install forge
			await installForge(packData, downloadDirectory, 'client');
		}
		
		progressElement.message = 'Modifying profile...';
		
		// Modify profile
		updateProfile(installDirectory, packDirectory, packData);
		
		// Try to import options
		try {
			fs.copyFileSync(path.join(installDirectory, 'options.txt'), path.join(packDirectory, 'options.txt'), fs.constants.COPYFILE_EXCL);
		} catch (error) {
			// Do nothing
		}
		
		// Separate manual mods
		const filteredMods = filterMods('client', packData);
		
		// Download mods
		const downloadMap = await downloadMods('client', filteredMods.automatic, modsDirectory, downloadDirectory, progressElement);
		
		// Cleanup mods
		// FIXME: Will not work for manual mods like 'mekanism' and 'mekanism-generators'
		const files = fs.readdirSync(modsDirectory);
		const mappedFiles = Array.from(downloadMap.values());
		const installedManualMods = [];
		for (const file of files) {
			if (mappedFiles.indexOf(file) == -1) {
				let found = false;
				
				for (const mod of filteredMods.manual) {
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
			progressElement.message = 'Waiting for manually initiated downloads...';
			progressElement.value = null;
			_.createHTML(`<div>${filteredMods.manual.length - installedManualMods.length} mod${filteredMods.manual.length - installedManualMods.length > 1 ? 's' : ''} could not be automatically downloaded. Click each button below to open the mod website and click the proper download link.</div>`, progressGroupElement);
			const manualPromises = [];
			
			for (const mod of filteredMods.manual) {
				if (installedManualMods.indexOf(mod.id) == -1) {
					const modLink = _.createHTML(`<div style='margin-bottom: 10px;'><span style='margin-right: 1em; font-weight: 500;'>${mod.name}</span><button class='mdc-button mdc-button--raised' style='margin: 10px 0; height: 32px; font-size: 0.75rem;'><span class='mdc-button__label'>Download</span></button></div>`, progressGroupElement);
					const downloadButton = modLink.querySelector('.mdc-button');
					manualPromises.push(new Promise((resolve) => {
						downloadButton.addEventListener('click', (event) => {
							event.preventDefault();
							ipcRenderer.send('manual-mod', mod.name, mod.url, modsDirectory);
							downloadButton.setAttribute('disabled', '');
							ipcRenderer.on('manual-mod', (event, modName, state) => {
								if (modName == mod.name) {
									let label;
								
									if (state == 'waiting') {
										label = 'Waiting for Download...';
									} else if (state == 'downloading') {
										label = 'Downloading...';
									} else {
										label = 'Download Complete';
										resolve();
									}
								
									downloadButton.querySelector('.mdc-button__label').innerText = label;
								}
							});
						});
					}));
				}
			}
			
			Promise.all(manualPromises).then(() => {
				progressElement.message = 'Modpack installation complete!';
				progressElement.value = 1;
			});
		} else {
			progressElement.message = 'Modpack installation complete!';
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
		
		const packData = packs.get(selectedPack);
		const modsDirectory = path.join(installDirectory, 'mods');
		const downloadDirectory = path.join(modsDirectory, 'downloading');
		
		// Create subdirectory
		fs.promises.mkdir(downloadDirectory, {recursive: true});
		
		progressGroupElement.style.display = '';
		
		// Separate manual mods
		const filteredMods = filterMods('server', packData);
		
		// Download and install forge
		await installForge(packData, installDirectory, 'server');
		
		// Download mods
		const downloadMap = await downloadMods('server', filteredMods.automatic, modsDirectory, downloadDirectory, progressElement);
		progressElement.message = 'Modpack installation complete!';
		
		// Cleanup mods
		// FIXME: Will not work for manual mods like 'mekanism' and 'mekanism-generators'
		const files = fs.readdirSync(modsDirectory);
		const mappedFiles = Array.from(downloadMap.values());
		const installedManualMods = [];
		for (const file of files) {
			if (mappedFiles.indexOf(file) == -1) {
				let found = false;
				
				for (const mod of filteredMods.manual) {
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
			progressElement.message = 'Waiting for manually initiated downloads...';
			progressElement.value = null;
			_.createHTML(`<div>${filteredMods.manual.length - installedManualMods.length} mod${filteredMods.manual.length - installedManualMods.length > 1 ? 's' : ''} could not be automatically downloaded. Click each button below to open the mod website and click the proper download link.</div>`, progressGroupElement);
			
			for (const mod of filteredMods.manual) {
				if (installedManualMods.indexOf(mod.id) == -1) {
					const modLink = _.createHTML(`<div style='margin-bottom: 10px;'><span style='margin-right: 1em; font-weight: 500;'>${mod.name}</span><button class='mdc-button mdc-button--raised' style='margin: 10px 0; height: 32px; font-size: 0.75rem;'><span class='mdc-button__label'>Download</span></button></div>`, progressGroupElement);
					const downloadButton = modLink.querySelector('.mdc-button');
					downloadButton.addEventListener('click', (event) => {
						event.preventDefault();
						ipcRenderer.send('manual-mod', mod.name, mod.url, modsDirectory);
						downloadButton.setAttribute('disabled', '');
						ipcRenderer.on('manual-mod', (event, modName, state) => {
							if (modName == mod.name) {
								let label;
								
								if (state == 'waiting') {
									label = 'Waiting for Download...';
								} else if (state == 'downloading') {
									label = 'Downloading...';
								} else {
									label = 'Download Complete';
								}
								
								downloadButton.querySelector('.mdc-button__label').innerText = label;
							}
						});
					});
				}
			}
		} else {
			progressElement.message = 'Modpack installation complete!';
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
		const paths = ipcRenderer.sendSync('folder-select', installDirectory, 'Locate your Minecraft installation directory...');
		
		if (paths) {
			installDirectory = paths[0];
			installDirElement.innerText = paths[0];
			await checkPrerequisites();
		}
	});
	
	runtimeDirChangeElement.addEventListener('click', async () => {
		const paths = ipcRenderer.sendSync('folder-select', runtimeDirectory ? runtimeDirectory : path.parse(process.env.APPDATA).root, 'Locate your Java runtime executable directory...');
		
		if (paths) {
			runtimeDirectory = paths[0];
			
			if (fs.existsSync(path.join(runtimeDirectory, 'jre.bundle'))) {
				runtimeDirectory = path.join(runtimeDirectory, 'jre.bundle', 'Contents', 'Home', 'bin');
			}
			
			runtimeDirElement.innerText = runtimeDirectory;
			await checkPrerequisites();
		}
	});
	
	versionElement.addEventListener('click', () => {
		ipcRenderer.send('open-devtools');
	});
	
//	// Open all links in external browser
//	document.addEventListener('click', (event) => {
//		if (event.target.tagName === 'A' && event.target.href.startsWith('http')) {
//			event.preventDefault();
//			shell.openExternal(event.target.href);
//		}
//	});
});

const _setImmediate = setImmediate;
process.once('loaded', () => {
	global.setImmediate = _setImmediate;
});
