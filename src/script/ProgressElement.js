class ProgressElement extends HTMLElement {
	set value(value) {
		if (value) {
			this.setAttribute('value', value);
		} else {
			this.removeAttribute('value');
		}
	}

	get value() {
		return this._value;
	}

	set message(value) {
		this._messageElement.innerHTML = value;
	}

	constructor() {
		super();

		this._maxValue = 1;
		this._value = null;

		let shadow = this.attachShadow({mode: 'open'});
		this._shadowElement = shadow;
		let messageElement = document.createElement('div');
		this._messageElement = messageElement;
		let progressElement = document.createElement('div');
		progressElement.className = 'progress';
		let valueElement = document.createElement('div');
		this._valueElement = valueElement;
		valueElement.className = 'value';
		let style = document.createElement('style');
		style.textContent = `
:host {
	display: block;
}

:host(:not([value])) .value {
	animation: indefinite 2.5s linear infinite;
}

.progress {
	box-sizing: border-box;
	display: inline-block;
	margin: 5px 0 10px 0;
	height: 1em;
	width: 100%;
	vertical-align: -0.2em;

	background: #5f5f5f;
	overflow: hidden;
}

.value {
	height: 100%;
	background: var(--mdc-theme-primary);
}

@keyframes indefinite {
	0% {
		width: 50%;
		margin-left: -50%;
	}

	100% {
		width: 50%;
		margin-left: 100%;
	}
}
`;

		shadow.appendChild(style);
		shadow.appendChild(messageElement);
		shadow.appendChild(progressElement);
		progressElement.appendChild(valueElement);

		let observer = new MutationObserver((records, observer) => {
			return this.observationCallback(records, observer);
		});
		let observationConfig = {attributeFilter: ['value', 'max'], attributes: true};
		observer.observe(this, observationConfig);
	}

	connectedCallback() {
		this.update();
	}

	observationCallback() {
		this.update();
	}

	update() {
		this._maxValue = this.hasAttribute('max') ? Number(this.getAttribute('max')) : 1;
		this._value = this.hasAttribute('value') ? Number(this.getAttribute('value')) : null;

		if (this._value) {
			let percent = this._value / this._maxValue * 100;

			this._valueElement.style.width = `${percent}%`;
		}
	}

	addProgress() {
		let progress = new ProgressElement();
		this._shadowElement.appendChild(progress);
		return progress;
	}

	remove() {
		this.parentNode.removeChild(this);
	}
}

customElements.define('progress-element', ProgressElement);
export default ProgressElement;
