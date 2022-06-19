async function progress(response, callback) {
	// https://javascript.info/fetch-progress
	const reader = response.body.getReader();
	const length = parseInt(response.headers.get('Content-Length'), 10);
	let receivedLength = 0;
	let chunks = [];
	
	while (true) {
		const {done, value} = await reader.read();
		
		if (done) {
			break;
		}
		
		chunks.push(value);
		receivedLength += value.length;
		
		callback({received: receivedLength, length, percent: receivedLength / length});
		// console.log(`Received ${receivedLength} of ${length}`);
	}
	
	const data = new Uint8Array(receivedLength);
	let position = 0;
	for (const chunk of chunks) {
		data.set(chunk, position);
		position += chunk.length;
	}
	
	return Buffer.from(data);
}

module.exports = progress;
