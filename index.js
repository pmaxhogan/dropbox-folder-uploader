const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");

const bypass = true;
const delayAdd = 250;
const token = fs.readFileSync(path.join(__dirname, "token.txt")).toString().trim();

const dir = "/home/max/Documents/dropbox-test";
const tree = [];
const getTree = (thisDir = ".") => {
	fs.readdirSync(path.join(dir, thisDir)).forEach(subItem => {
		console.log(thisDir, subItem);
		if(fs.statSync(path.join(dir, thisDir, subItem)).isFile()){
			tree.push(path.join(thisDir, subItem));
		}else{
			getTree(subItem);
		}
	});
};
getTree();
console.log(tree);
const promises = [];

const sleep = delay => new Promise(resolve => setTimeout(resolve, delay));

const queue = {};

tree.forEach((file, inc) => {
	queue[file] = 0;
	const isBigFile = fs.statSync(path.join(dir, file)).size / 1000000 > 150;
	console.log(file, isBigFile);
	if(isBigFile){
		queue[file] = 3;
	}else{

		const fetchIt = async function(delay){
			await sleep(delay);
			queue[file] = 1;
			if(bypass){
				await sleep(1000);
				return queue[file] = 3;
			}
			const response = await fetch("https://content.dropboxapi.com/2/files/upload", {
			  body: fs.createReadStream(path.join(dir, file)),
			  headers: {
			    Authorization: "Bearer " + token,
			    "Content-Type": "application/octet-stream",
			    "Dropbox-Api-Arg": JSON.stringify({"path": "/" + file, "mode": "add","autorename": true,"mute": false})
			  },
			  method: "POST"
			});
			if(response.ok){
				console.log("uploaded", file);
				queue[file] = 3;
				return await response.text();
			}
			queue[file] = 0;
			if(response.status === 429){
				const delay = parseInt(response.headers.get("Retry-After")) * 1000;
				console.log("Waiting for", delay, "ms");
				return await fetchIt(delay);
			}else{
				const error = await response.text();
				console.error(file, response.status, error);
			}
		};
		promises.push(fetchIt(inc * delayAdd));
	}
});
Promise.all(promises).then(() => {
	console.log("DONE");
	process.exit();
});


// setInterval(()=>console.log(queue), 1000);

if(process.stdout.isTTY){
	console.log("press s for status.");
	process.stdin.setRawMode(true);
	process.stdin.resume();
	process.stdin.on("data", (key) => {
		key = key.toString();
		switch(key){
		 	case "\u0003":
				console.log("bye!");
				process.exit();
				break;
			case "s":
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

				console.log(`${entries.length} total, ${queued} queued, ${started} started, ${finished} finished`);
				break;
			default:
				console.log("unknown key");
    }
	});
}
