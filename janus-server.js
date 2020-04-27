#!/usr/bin/env node

require('dotenv').config();

runningOnPi = (process.env.ON_PI == "true");

var gpio;
if(runningOnPi) {
  gpio = require("rpi-gpio");
}
var RaspiCam;
var camera;
if(runningOnPi) {
  RaspiCam = require("raspicam");
} 

var door0_pin = 16; // Pi GPIO23
var door1_pin = 18; // Pi GPIO24

const fs = require('fs');
const moment = require('moment');
var spawn = require('child_process').spawn;

var imageUploadLocks = {
  "archive": false,
  "refresh" : false
}

var imagePath = "/tmp/garage-image.jpg";

/**
 * GCS Initialization
 */
const {Storage} = require('@google-cloud/storage');
const storage = new Storage();
const bucketName = 'janus-223601';
const bucket = storage.bucket(bucketName);

/**
 * Firebase initialization
 */
const {Firestore} = require('@google-cloud/firestore');
const firestore = new Firestore();
const doorCollection = "door_requests";
const imageCollection = "image_requests"

var lastRefreshAt = 0;
var lastArchiveAt = 0;

function getLock(archive) {
  key = archive ? "archive" : "refresh";
  return imageUploadLocks[key];
}

function setLock(archive, lockState) {
  key = archive ? "archive" : "refresh";
  imageUploadLocks[key] = lockState;
}


function uploadFreshImage(archive=false, callback) {
  img_path = '/tmp/garage-image.jpg';

  if(getLock(archive)) {
    console.log("already uploading image, aborting new request");
    return;
  }
  if(!runningOnPi) { // we don't have a timelapse going locally, so grab a fresh image before uploading
    // launch an imagesnap process to continuously capture the current image
      var args = ["-w", "1.0", "-q", `/tmp/garage-image.jpg`];
      proc = spawn('imagesnap', args);
      proc.on('error', function(err) {
        console.log('WARN: No imagesnap binary available.  Ensure /tmp/garage-image.jpg exists.');
      });    
  }
  basename = runningOnPi ? "garage-image" : "nopi-image";

  if(archive) {
    bucketDest = `${basename}-archive/${basename}-` + moment().format('YYYY-MM-DD-HH-mm-ss') + ".jpg"
  } else {
    bucketDest = `${basename}.jpg`;
  }

  setLock(archive, true);
  // upload and then notify
  fs.stat(img_path, function(err, stat) {
    if(err == null) {
      // the file exists
      bucket.upload(img_path, {destination: bucketDest, metadata: {
          cacheControl: 'no-cache, no-store, must-revalidate',
          pragma: 'no-cache',
          expires: 0
        }},
        function(err, file, apiResponse) {
          if(err) {
            console.log("Error uploading image.", err);
          } else {
            if(!archive) {
              file.makePublic();
              lastRefreshAt = Date.now();
            } else {
              lastArchiveAt = Date.now();
            }
          }
        }
      );
    } else if(err.code == 'ENOENT') {
        // file does not exist
        console.log("File " + img_path + " does not exist, skipping upload.")
        setLock(archive, false);
    } else {
        console.log('Error looking for image file: ', err.code);
        setLock(archive, false);
    }
    setLock(archive, false);
  });
}

function pushGarageButton(door) {
    console.log("toggle garage door ", door);
    var door_pin = door0_pin;
    if(door > 0) {
      door_pin = door1_pin;
    }

    if(runningOnPi) {
      gpio.open(door_pin, "output pullup", function() {
        gpio.write(door_pin, 0);
        console.log("on");
        setTimeout(function() {
          console.log("off");
          gpio.write(door_pin, 1);
          gpio.close(door_pin);
        }, 1000);
      });
    } else {
      console.log("[nopi] GPIO pin triggered")
    }
}

// Mark the door/image request as completed
// by updating the record in Firestore.
function updateRequest(collection, doc_id, new_status) {
  // create a reference to the doc we are updating
  var docRef = firestore.collection(collection).doc(doc_id);

  return firestore.runTransaction(function(transaction) {
      // This code may get re-run multiple times if there are conflicts.
      return transaction.get(docRef).then(function(doc) {
          if (!doc.exists) {
              throw "Document does not exist: " + doc_id;
          }
          transaction.update(docRef, { status: new_status })
      });
  }).then(function() {
      console.log(`Marked ${collection} request ${doc_id} ${new_status}.`);
  }).catch(function(error) {
      console.log(`Transaction failed for ${collection} request ${doc_id}: `, error);
  });
}

/*
 * Camera Setup
 */

// Create and start the running camera.
// The Pi camera has a startup time before the exposure settles in
// so we just run it continuously, taking a photo every 2 seconds
// and then when we just grab the latest when uploading to the cloud
if(runningOnPi) {
  camera = new RaspiCam({
    mode: "timelapse",
    output: imagePath,
    log: function() {}, // disable verbose RaspiCam logging
    // ./timelapse/image_%06d.jpg", // image_000001.jpg, image_000002.jpg,...
    width: 800,
    height: 600,
    quality: 80,
    encoding: "jpg",
    timelapse: 2000, // take a picture every 2 seconds
    timeout: 0, // never exit unless parent process does    
    hf: true, // we flip horiz and vert to compensate for the camera...
    vf: true  // ...which is mounted upside down in garage
  });

  camera.on("start", function(err, timestamp ) {
    console.log(new Date().toISOString() + " timelapse started at " + timestamp);
  });

  camera.on("read", function(err, timestamp, filename ){
    //console.log("timelapse image captured with filename: " + filename);

    // TODO: every ~30 seconds, we want to proactively freshen the garage-image.jpg on Cloud
    if(timestamp > (lastRefreshAt + 30*1000)) {
      console.log(new Date().toISOString() + " refreshing image to Cloud");
      uploadFreshImage();
    }
    // TODO: every ~30 minutes, we want to push to the corpus of historical photos for some AutoML later
    if(timestamp > (lastRefreshAt + 30*60*1000)) {
      console.log(new Date().toISOString() + " adding image to Cloud archive");
      uploadFreshImage(true);
    }
  });

  camera.on("exit", function(timestamp ) {
    console.log(new Date().toISOString() + " timelapse child process has exited");
  });

  camera.on("stop", function(err, timestamp ){
    console.log(new Date().toISOString() + " timelapse child process has been stopped at " + timestamp);
  });

  camera.start();
} else {
  console.log("[nopi] Using imagesnap when needed instead of raspi camera timelapse");
  // Set up recurring interval locally to grab and update images
  setInterval(() => { 
    console.log("[nopi] refreshing image to Cloud");
    uploadFreshImage();
  }, 5000); // 5 seconds

  setInterval(() => { 
    console.log("[nopi] adding image to Cloud archive");
    uploadFreshImage(true);
  }, 1000*60); // 1 minute
}



/*
 * Firestore Messaging Setup
 */

// Monitor Firestore for any pending door requests
firestore.collection(doorCollection).where("status", "==", "pending")
    .onSnapshot(function(querySnapshot) {
        querySnapshot.forEach((doc) => {
            //console.log(`${doc.id} => ${JSON.stringify(doc.data(), null, 4)}`);
            request_date = doc.data().requested_at.toDate();
            seconds_old = moment().diff(moment(request_date), 'seconds');
            if(seconds_old >= 10) {
              console.log("Cowardly refusing to open garage door based on request made",
                          moment(request_date).fromNow());
              updateRequest(doorCollection, doc.id, "timeout");
            } else {
              pushGarageButton(doc.data().door);
              // we have confidence that the button is being pushed,
              // albeit asynchronously, we'll acknowledge the request now
              updateRequest(doorCollection, doc.id, "completed");
          }
        });
    }, function(error) {
        console.log("door_requests listener died with error:", error)
        // Haven't seen this ever happen in practice.
        // If it does, we need to do something here.
        // Maybe notify me that there was an error?
        // Once this state is reached, the listener is dead and we'll
        // need to restart it somehow, app will be offline
    });

// Monitor Firestore for any pending image requests
firestore.collection(imageCollection).where("status", "==", "pending")
    .onSnapshot(function(querySnapshot) {
        querySnapshot.forEach((doc) => {
            //console.log(`${doc.id} => ${JSON.stringify(doc.data(), null, 4)}`);
            uploadFreshImage(function(error) {
              if(error) {
                console.log("upload image failed:", error)
              } else {
                updateRequest(imageCollection, doc.id, "completed");
              }
            });
        });
    }, function(error) {
        console.log("image_requests listener died with error:", error)
    });


/* 
 * All set, ready to rock!
 */

console.log("Janus Booted and ready to serve your garage door needs.")
