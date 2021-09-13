const _ = {};

(() => {
	let insertElement = document.createElement('div');

	_.request = (url, method, headers, body) => {
		method = method ? method : 'GET';

		return fetch(url, {
			method: method,
			cache: 'no-cache',
			headers: headers ? headers : undefined,
			body: method == 'GET' || method == 'HEAD' || !body ? undefined : body,
		});
	};

	_.getJSON = (url, headers) => {
		return _.request(url, 'GET', headers).then((response) => {
			return response.json();
		});
	};

	_.createHTML = (htmlString, parentElement) => {
		let returnValue = null;

		insertElement.insertAdjacentHTML('beforeend', htmlString);

		if (insertElement.childNodes.length == 0) {
			return null;
		} else {
			returnValue = [...insertElement.childNodes];
		}

		// Remove new nodes from dummy element
		while (insertElement.lastChild) {
			insertElement.removeChild(insertElement.lastChild);
		}

		// Insert elements into new parent
		if (parentElement) {
			for (let element of returnValue) {
				parentElement.appendChild(element);
			}
		}

		if (returnValue.length == 1) {
			return returnValue[0];
		}

		return returnValue;
	};
})();

module.exports = _;
