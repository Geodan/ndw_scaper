var fs		= require('fs')
  , zlib		  = require('zlib')
  , path	  = require('path')
  , XmlStream = require('xml-stream')
  , { Pool }  = require('/usr/local/lib/node_modules/pg')
  , copy	  = require('/usr/local/lib/node_modules/pg-copy-streams')
  , request   = require('/usr/local/lib/node_modules/request')
  , SQL	   = require('sql-template-strings');

var incidentClassTypes = {
	'AbnormalTraffic': 'abnormalTrafficType',
	'Accident': 'accidentType',
	'AuthorityOperation': 'authorityOperationType',
	'DisturbanceActivity': 'disturbanceActivityType',
	'PublicEvent': 'publicEventType',
	'PoorEnvironmentConditions': 'poorEnvironmentType',
	'NonWeatherRelatedRoadConditions': 'nonWeatherRelatedRoadConditionType',
	'WeatherRelatedRoadConditions': 'weatherRelatedRoadConditionType',
	'EquipmentOrSystemFault': 'faultyEquipmentOrSystemType',
	'AnimalPresenceObstruction': 'animalPresenceType',
	'EnvironmentalObstruction': 'environmentalObstructionType',
	'GeneralObstruction': 'obstructionType',
	'InfrastructureDamageObstruction': 'infrastructureDamageType',
	'VehicleObstruction': 'vehicleObstructionType'
}

function readXML() {
	return new Promise(function(resolve, reject) {
		var nodes = [];
		var stream = request.get('http://opendata.ndw.nu/incidents.xml.gz')
				.pipe(zlib.createGunzip());
		var xml = new XmlStream(stream, 'utf8');
		xml.collect('values');
		xml.on('updateElement: situation', function(node) {
			nodes.push(node);
		});
		xml.on('error', async function(message) {
			reject('XML parsing failed: ' + message);
		});
		xml.on('end', async function(){
			console.log('XML closed');
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
		var nodes = await readXML();
		console.log('read ' + nodes.length + ' nodes');
		await client.query('BEGIN');
		await client.query('UPDATE ndw.incidents SET active = 0 WHERE active = 1');

		var counter = 0;
		
		for(var i=0; i<nodes.length; i++) {
			const node = nodes[i];
			//console.log(node);
			var observationtime = node.situationRecord.situationRecordObservationTime;
			var probabilityofoccurrence = node.situationRecord.probabilityOfOccurrence;
			var id = node.$.id;
			var version = node.$.version;
			var source = node.situationRecord.source.sourceName.values[0].value.$text;
			var location = node.situationRecord.groupOfLocations.locationForDisplay;
			var incidentclass = node.situationRecord.$['xsi:type'];
			var incidenttype = 'Unknown';
			if (incidentClassTypes.hasOwnProperty(incidentclass)) {
				var typeField = incidentClassTypes[incidentclass];
				incidenttype = node.situationRecord[typeField];
			}
			
			//console.log(observationtime, id, version, probabilityofoccurrence, source, accidenttype,location);

			//console.log(counter++,'---------------------------------');

			//Stream to db
			var querystring = SQL`
				INSERT INTO ndw.incidents
				(id, version, active, observationtime, probabilityofoccurrence, source, 
					incidentclass, incidenttype, latitude, longitude, geom)
				VALUES (
					${id},
					${version},
					1,
					${observationtime},
					${probabilityofoccurrence},
					${source},
					${incidentclass},
					${incidenttype},
					${location.latitude},
					${location.longitude},
					ST_SetSRID(ST_MakePoint(${location.longitude}, ${location.latitude}), 4326)
				)
				ON CONFLICT ON CONSTRAINT incidents_pkey DO UPDATE SET active = 1;
			`;
			await client.query(querystring);
		};
		await client.query('COMMIT');
	} catch (e) {
		await client.query('ROLLBACK');
		throw e;
	} finally {
		client.release();
	}
})().catch(e => console.error(e.stack))

