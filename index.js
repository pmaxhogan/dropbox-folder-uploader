const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");
const readline = require("readline");
const ansi = require("ansi.js");
const cursor = ansi(process.stdout);

const ESC = "\x1B[";

const bypass = false;
const delayAdd = 1000;
const fileSplitSize = 1 * 150;//1000000 * 150
const token = fs.readFileSync(path.join(__dirname, "token.txt")).toString().trim();

const dir = process.argv[2];
const tree = [];

const getTree = (thisDir = ".") => {
	fs.readdirSync(path.join(dir, thisDir)).forEach(subItem => {
		if(fs.statSync(path.join(dir, thisDir, subItem)).isFile()){
			tree.push(path.join(thisDir, subItem));
		}else{
			getTree(subItem);
		}
	});
};
getTree();
const promises = [];

const sleep = delay => new Promise(resolve => setTimeout(resolve, delay));

const queue = {};

const getStatus = () => {
	const entries = Object.entries(queue);
	let queued = 0;
	let started = 0;
	let finished = 0;
	entries.forEach(([file, status]) => {
		switch (status) {
			case 0:
				queued ++;
				break;
			case 1:
				started ++;
				break;
			case 3:
				finished ++;
		}
	});
	return {queued, started, finished};
};

const clearAndLog = (...args) => {
		cursor.moveToColumn(0).eraseLine();
		console.log(...args);
		updateBar();
};

const updateBar = () => {
	cursor.fg.reset();
	cursor.bg.reset();
	cursor.font.resetBold().resetItalic().resetUnderline().resetInverse();
	let {queued, started, finished} = getStatus();
	const columns = process.stdout.columns - 2;
	cursor.moveToColumn(0).eraseLine().
  write("[" + "█".repeat(Math.floor(finished / tree.length * columns)) + "-".repeat(Math.ceil((tree.length - finished) / tree.length * columns)) + "]");
};

cursor.fg.blue();
clearAndLog(tree.join("\n"));

tree.forEach((file, inc) => {
	queue[file] = 0;
	updateBar();
	const thisSize = fs.statSync(path.join(dir, file)).size;
	const isBigFile = thisSize > fileSplitSize;
	const fetchIt = async function(delay){
		await sleep(delay);
		queue[file] = 1;
		updateBar();
		if(bypass){
			await sleep(1000);
			return queue[file] = 3;
			updateBar();
		}

		const procResponse = async function(response, file, retry){
			if(response.ok){
				clearAndLog("uploaded", file);
				if(file) queue[file] = 3;
				updateBar();
				return await response.text();
			}
			if(file) queue[file] = 0;
			updateBar();
			if(response.status === 429){
				const delay = parseInt(response.headers.get("Retry-After")) * 1000;
				cursor.fg.red();
				cursor.font.bold();
				clearAndLog(file, "could not send, retrying in", delay, "ms");
				return await retry(delay);
			}else{
				const error = await response.text();
				cursor.fg.red();
				cursor.font.bold();
				clearAndLog(file, "could not send! Got status code", response.status, "got error", error);
				return await retry(500);
			}
		};

		const procError = e => {
			if(e.code === "ENOTFOUND"){
				cursor.fg.red();
				cursor.font.bold();
				clearAndLog("Got ENOTFOUND! Are you connected to the internet? Retrying in 500ms...");
			}else{
				cursor.fg.red();
				cursor.font.bold();
				clearAndLog("Unknown error", e.code, "! Retrying in 500ms...", e);
			}
		};

		if(isBigFile){
			let hasChunkLeft = true;
			let lastByte = -1;

			const chunkPromises = [];
			const startIt = async function(delay, stream){
				try{
					clearAndLog("started", file, "with delay", delay);
					await sleep(delay);
					const resp = await fetch("https://content.dropboxapi.com/2/files/upload_session/start", {
						body: stream,
						headers: {
							Authorization: "Bearer " + token,
							"Content-Type": "application/octet-stream",
							"Dropbox-Api-Arg": JSON.stringify({close: false})
						},
						method: "POST"
					});
					clearAndLog("start finished sending");
					const data = await procResponse(resp, null, startIt);
					return JSON.parse(data).session_id
				}catch(e){
					procError(e);
					return await startIt(500, stream);
				}
			};

			while(hasChunkLeft){
				const thisRange = [lastByte + 1, Math.min(lastByte + 1 + fileSplitSize, thisSize)];

				clearAndLog("chunked", file, "as", thisRange);
				if(thisRange[1] >= thisSize){
					hasChunkLeft = false;
					clearAndLog(file, "is done chunking");
					return;
				}
				lastByte = thisRange[1];
				const stream = fs.createReadStream(path.join(dir, file), {
					start: thisRange[0],
					end: thisRange[1]
				});
				const isFirst = thisRange[0] === 0;
				if(isFirst){
					sessionId = await startIt(0, stream);
				}else{
					chunkPromises.push(async function (){
						clearAndLog("got session_id", sessionId, "for file", file, "uploading starting at offset", thisRange[0]);

						const sendThis = async function(delay = 0, stream){
							try{
								await sleep(delay);
								const response = await fetch("https://content.dropboxapi.com/2/files/upload_session/append_v2", {
								  body: stream,
								  headers: {
								    Authorization: "Bearer " + token,
								    "Content-Type": "application/octet-stream",
								    "Dropbox-Api-Arg": JSON.stringify({
											cursor: {
												offset: thisRange[0],
												session_id: sessionId
											},
											close: false
										})
								  },
								  method: "POST"
								});
								clearAndLog("chunk finished sending");
								procResponse(response, null, sendThis);
							}catch(e){
								procError(e);
								return await sendThis(500, stream);
							}
						};
						await sendThis();
					});
				}
			}

			await Promise.all(chunkPromises);
			const stream = fs.createReadStream(path.join(dir, file), {
				start: lastByte,
				end: thisSize
			});
			const sendFinal = async function(delay = 0, stream){
				try{
					await sleep(delay);
					const response = await fetch("https://content.dropboxapi.com/2/files/upload_session/finish", {
						body: stream,
						headers: {
							Authorization: "Bearer " + token,
							"Content-Type": "application/octet-stream",
							"Dropbox-Api-Arg": JSON.stringify({
								cursor: {
						        "session_id": sessionId,
						        "offset": thisSize
						    },
								commit: {
									path: "/" + file,
									mode: "add",
									autorename: true,
									mute: false
								}
							})
						},
						method: "POST"
					});
					clearAndLog("final finished sending", thisSize);
					procResponse(response, null, sendFinal);
				}catch(e){
					procError(e);
					return await sendFinal(500, stream);
				}
			};
			await sendFinal(0, stream);
			clearAndLog("finihed sending big file", file);
			return;
		}else{
			try{
				const response = await fetch("https://content.dropboxapi.com/2/files/upload", {
				  body: fs.createReadStream(path.join(dir, file)),
				  headers: {
				    Authorization: "Bearer " + token,
				    "Content-Type": "application/octet-stream",
				    "Dropbox-Api-Arg": JSON.stringify({"path": "/" + file, "mode": "add","autorename": true,"mute": false})
				  },
				  method: "POST"
				});
				return await procResponse(response, file, fetchIt);
			}catch(e){
				procError(e);
				return await fetchIt(500);
			}
		}
	};
	promises.push(fetchIt(inc * delayAdd));
});
Promise.all(promises).then(() => {
	clearAndLog(queue);
	cursor.font.bold().inverse();
	cursor.fg.green();
	clearAndLog("Completed!");
	cursor.fg.reset();
	cursor.bg.reset();
	cursor.font.resetBold().resetItalic().resetUnderline().resetInverse();
	process.exit();
});

if(process.stdout.isTTY){
	cursor.fg.red();
	cursor.font.bold();
	clearAndLog("Press s for status.");
	process.stdin.setRawMode(true);
	process.stdin.resume();
	process.stdin.on("data", (key) => {
		key = key.toString();
		switch(key){
		 	case "\u0003":
				clearAndLog("bye!");
				process.exit();
				break;
			case "s":
				let {queued, started, finished} = getStatus();
				cursor.moveToColumn(0).eraseLine();
				cursor.fg.green();
				clearAndLog(`${tree.length} total, ${queued} queued, ${started} started, ${finished} finished`);
				break;
			default:
				clearAndLog("unknown command");
    }
	});
}
