var fs		= require('fs')
  , zlib		  = require('zlib')
  , path	  = require('path')
  , XmlStream = require('xml-stream')
  , { Pool }  = require('/usr/local/lib/node_modules/pg')
  , copy	  = require('/usr/local/lib/node_modules/pg-copy-streams')
  , request   = require('/usr/local/lib/node_modules/request')
  , SQL	      = require('/usr/local/lib/node_modules/sql-template-strings');

const LOCATION_URL = 'http://opendata.ndw.nu/LocatietabelDRIPS.xml.gz';
const DATA_URL = 'http://opendata.ndw.nu/DRIPS.xml.gz';
const DEBUG = true;

function log(message){
	if(DEBUG) 
		console.log(message);
}
function logerror(message){
	console.error(message);
}

function readLocationXML() {
	return new Promise(function(resolve, reject) {
		var locations = {};
		var counter = 0;
		var stream = request.get(LOCATION_URL)
				.pipe(zlib.createGunzip());
		var xml = new XmlStream(stream, 'utf8');
		xml.on('updateElement: vmsUnitRecord', function(node) {
			let id = node.$['id'];
			if (!node.vmsRecord || !node.vmsRecord.vmsRecord || !node.vmsRecord.vmsRecord.vmsLocation) return;
			if (node.vmsRecord.vmsRecord.vmsLocation.$['xsi:type'] != 'Point') return;
			let location = node.vmsRecord.vmsRecord.vmsLocation.locationForDisplay;
			counter++;
			if (DEBUG && counter % 100 == 0) {
				process.stdout.write('reading DRIPS location record ' + counter + "\r");
			}
			locations[id] = location;
		});
		xml.on('error', function(message) {
			reject('XML parsing failed: ' + message);
		});
		xml.on('end', function(){
			//log('XML closed');
			resolve(locations);
		});
	});
}

function readDataXML() {
	return new Promise(function(resolve, reject) {
		var nodes = [];
		var counter = 0;
		var stream = request.get(DATA_URL)
				.pipe(zlib.createGunzip());
		var xml = new XmlStream(stream, 'utf8');
		xml.collect('vmsTextLine');
		xml.on('updateElement: vmsUnit', function(node) {
			let id = node.vmsUnitReference.$['id'];
			let version = node.vmsUnitReference.$['version'];
			if (!node.vms || !node.vms.vms || 
				!node.vms.vms.vmsMessage || !node.vms.vms.vmsMessage.vmsMessage) return;
			let vmsMessage = node.vms.vms.vmsMessage.vmsMessage;
			let vmsTime = vmsMessage.timeLastSet;
			let text = undefined;
			let imageData = undefined;
			if (vmsMessage.textPage) {
				text = vmsMessage.textPage.vmsText.vmsTextLine.map((line) => {
					return line.vmsTextLine[0].vmsTextLine[0];
				}).join('\n');
				//log(text);
			} else if (vmsMessage.vmsMessageExtension) {
				let image = vmsMessage.vmsMessageExtension.vmsMessageExtension.vmsImage;
				if (image.imageData.encoding == 'base64' && image.imageData.mimeType == 'image/png') {
					imageData = image.imageData.binary;
				} else {
					log('unknown image format for id ' + id);
					return;
				}
				//log(image); 
			} else {
				log('unknown message for id ' + id);
				return;
			}
			nodes.push({
				id: id,
				version: version,
				time: vmsTime,
				text: text,
				image: imageData
			});
			counter++;
			if (DEBUG && counter % 100 == 0) {
				process.stdout.write('reading DRIPS location record ' + counter + "\r");
			}
		});
		xml.on('error', function(message) {
			reject('XML parsing failed: ' + message);
		});
		xml.on('end', function(){
			//log('XML closed');
			resolve(nodes);
		});
	});
}

//Prepare PG
const pool = new Pool({
	host: 'localhost',
	port: 5433,
	user: 'postgres',
	password: '',
	database: 'research'
});

(async () => {
	// note: we don't try/catch this because if connecting throws an exception
	// we don't need to dispose of the client (it will be undefined)
	const client = await pool.connect();

	try {
		let locations = await readLocationXML();
		log('\nread ' + Object.keys(locations).length + ' locations');
		let data = await readDataXML();
		log('\nread ' + data.length + ' data nodes');
		log('beginning transaction');
		await client.query('BEGIN');
		await client.query('UPDATE ndw.drips SET active = 0 WHERE active = 1');

		var counter = 0;
		
		for(var i=0; i<data.length; i++) {
			const node = data[i];
			const location = locations[node.id];
			if (!location) {
				log('location not found for id ' + node.id);
				continue;
			}
			//log(node);
			const latitude = locations[node.id].latitude;
			const longitude = locations[node.id].longitude;
			var querystring = SQL`
				INSERT INTO ndw.drips
				(id, version, active, time, text, image, latitude, longitude, geom)
				VALUES (
					${node.id},
					${node.version},
					1,
					${node.time},
					${node.text},
					${node.image},
					${latitude},
					${longitude},
					ST_SetSRID(ST_MakePoint(${longitude}, ${latitude}), 4326)
				)
				ON CONFLICT ON CONSTRAINT drips_pkey DO UPDATE SET active = 1;
			`;
			await client.query(querystring);
			counter++;
		};
		log('wrote ' + counter + ' records');
		log('committing transaction');
		await client.query('COMMIT');
	} catch (e) {
		await client.query('ROLLBACK');
		throw e;
	} finally {
		client.release();
		log('done, please wait until process exits');
	}
})().catch(e => logerror(e.stack))

