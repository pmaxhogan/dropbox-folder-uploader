const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");
const ansi = require("ansi.js");
const commander = require("commander");
const cursor = ansi(process.stdout);

commander.
	version(require("./package.json").version).
	option("-v, --verbose", "Show extra debug output.").
	option("-t, --timeout <ms>", "Wait for n ms between uploads and before retrying failed requests. Default: 500").
	option("-T, --token [token]", "Use this token (instead of " + __dirname + "/token.txt" + ") for the Dropbox API");

commander.parse(process.argv);

const bypass = false;
const delayAdd = parseInt(commander.timeout) || 500;
const fileSplitSize = 1000000 * 150;//1000000 * 150
const token = commander.token || fs.readFileSync(path.join(__dirname, "token.txt")).toString().trim();

const dir = commander.args[0];
const tree = [];

const getTree = (thisDir = ".") => {
	try{
		fs.readdirSync(path.join(dir, thisDir)).forEach(subItem => {
			if(fs.statSync(path.join(dir, thisDir, subItem)).isFile()){
				tree.push(path.join(thisDir, subItem));
			}else{
				getTree(path.join(thisDir, subItem));
			}
		});
	}catch(e){
		if(e.code === "ENOENT"){
			cursor.fg.red();
			cursor.font.bold();
			console.error("Directory", path.join(dir, thisDir), "could not be found!");
			cursor.font.resetBold();
			cursor.fg.reset();
			process.exit(1);
		}
	}
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
	entries.forEach(([, status]) => {
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
	let {finished} = getStatus();
	const columns = process.stdout.columns - 2;
	cursor.moveToColumn(0).eraseLine().
		write("[" + "█".repeat(Math.floor(finished / tree.length * columns)) + "-".repeat(Math.ceil((tree.length - finished) / tree.length * columns)) + "]");
};

const log = (...args) => {
	cursor.fg.blue();
	clearAndLog(...args);
};

const verbose = (...args) => {
	if(!commander.verbose) return;
	clearAndLog(...args);
};

const error = (...args) => {
	cursor.fg.red();
	cursor.font.bold();
	clearAndLog(...args);
};

cursor.fg.blue();
log(tree.join("\n"));

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
			queue[file] = 3;
			return updateBar();
		}

		const procResponse = async function(response, file, retry){
			verbose("file", file, "had response", response.status);
			if(response.ok){
				log("uploaded", file);
				if(file) queue[file] = 3;
				updateBar();
				return await response.text();
			}
			if(file) queue[file] = 0;
			updateBar();
			if(response.status === 429){
				const delay = parseInt(response.headers.get("Retry-After")) * 1000;
				error(file, "could not send, retrying in", delay, "ms");
				return await retry(delay);
			}else{
				const error = await response.text();
				error(file, "could not send! Got status code", response.status, "got error", error);
				return await retry(delayAdd);
			}
		};

		const procError = e => {
			if(e.code === "ENOTFOUND"){
				error("Got ENOTFOUND! Are you connected to the internet? Retrying in " + delayAdd + "ms...");
			}else{
				error("Unknown error", e.code, "! Retrying in " + delayAdd + "ms...", e);
			}
		};

		if(isBigFile){
			let hasChunkLeft = true;
			let lastByte = -1;

			const chunkPromises = [];
			const startIt = async function(delay, stream){
				try{
					verbose("started", file, "with delay", delay);
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
					verbose("start finished sending");
					const data = await procResponse(resp, null, startIt);
					return JSON.parse(data).session_id;
				}catch(e){
					procError(e);
					return await startIt(delayAdd, stream);
				}
			};

			let sessionId;

			while(hasChunkLeft){
				const thisRange = [lastByte + 1, Math.min(lastByte + 1 + fileSplitSize, thisSize)];

				verbose("chunked", file, "as", thisRange);
				if(thisRange[1] >= thisSize){
					hasChunkLeft = false;
					verbose(file, "is done chunking");
					break;
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
						verbose("got session_id", sessionId, "for file", file, "uploading starting at offset", thisRange[0]);

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
								verbose("chunk finished sending");
								procResponse(response, null, sendThis);
							}catch(e){
								procError(e);
								return await sendThis(delayAdd, stream);
							}
						};
						await sendThis();
					});
				}
			}

			await Promise.all(chunkPromises);
			const stream = fs.createReadStream(path.join(dir, file), {
				start: lastByte + 1,
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
									"offset": lastByte + 1
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
					verbose("final finished sending", thisSize);
					procResponse(response, null, sendFinal);
				}catch(e){
					procError(e);
					return await sendFinal(delayAdd, stream);
				}
			};
			await sendFinal(0, stream);
			log("finished sending big file", file);
			queue[file] = 3;
			return;
		}else{
			try{
				verbose("uploading", file);
				const response = await fetch("https://content.dropboxapi.com/2/files/upload", {
					body: fs.createReadStream(path.join(dir, file)),
					headers: {
						Authorization: "Bearer " + token,
						"Content-Type": "application/octet-stream",
						"Dropbox-Api-Arg": JSON.stringify({"path": "/" + file, "mode": "add","autorename": true,"mute": false})
					},
					method: "POST"
				});
				verbose("uploaded", file);
				return await procResponse(response, file, fetchIt);
			}catch(e){
				procError(e);
				return await fetchIt(delayAdd);
			}
		}
	};
	promises.push(fetchIt(inc * delayAdd));
});
Promise.all(promises).then(() => {
	log("\nUploaded:");
	log(tree.join("\n"));
	log("Successfully uploaded", tree.length, "files!");
	cursor.moveToColumn(0).eraseLine();
	cursor.font.bold().inverse();
	cursor.fg.green();
	cursor.write("Completed!\n\n");
	cursor.fg.black();
	cursor.font.resetBold().resetInverse();
	process.stdout.write("\x1B[m");
	setImmediate(process.exit);
});

if(process.stdout.isTTY){
	cursor.fg.red();
	cursor.font.bold();
	clearAndLog("Press s for status.");
	process.stdin.setRawMode(true);
	process.stdin.resume();
	process.stdin.on("data", (key) => {
		key = key.toString();
		let {queued, started, finished} = getStatus();
		switch(key){
		case "\u0003":
			clearAndLog("bye!");
			process.exit();
			break;
		case "s":
			cursor.moveToColumn(0).eraseLine();
			cursor.fg.green();
			clearAndLog(`${tree.length} total, ${queued} queued, ${started} started, ${finished} finished`);
			break;
		default:
			clearAndLog("unknown command");
		}
	});
}
