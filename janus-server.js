require('dotenv').config();

runningOnPi = (process.env.ON_PI == "true");

var gpio;
if(runningOnPi) {
  gpio = require("pi-gpio");
}
var raspberryPiCamera;
if(runningOnPi) {
  raspberryPiCamera = require('raspberry-pi-camera-native');
} 

var door0_pin = 16; // Pi GPIO23
var door1_pin = 18; // Pi GPIO24

const fs = require('fs');
const moment = require('moment');

var imageUploadLock = false;
var imageCaptureLock = false;

/**
 * GCS Initialization
 */
const {Storage} = require('@google-cloud/storage');
const projectId = 'janus-223601';
const bucketName = 'janus-223601';
const storage = new Storage({projectId: projectId});
const bucket = storage.bucket(bucketName);

/**
 * Firebase initialization
 */
const firebase = require("firebase-admin");
const serviceAccount = require('./janus-223601-firebase-adminsdk-p8zrn-7350151901.json');

require("firebase/firestore");
firebase.initializeApp({
  //apiKey: '### FIREBASE API KEY ###',
  //authDomain: '### FIREBASE AUTH DOMAIN ###',
  projectId: 'janus-223601',
  databaseURL: "https://janus-223601.firebaseio.com",
  credential: firebase.credential.cert(serviceAccount)
});
// Initialize Cloud Firestore through Firebase
var firestoreDB = firebase.firestore();

// Disable deprecated features
firestoreDB.settings({
  timestampsInSnapshots: true
});

const doorCollection = "door_requests";
const imageCollection = "image_requests"

function captureNewImage(callback, img_name='garage-image.jpg') {
  if(imageCaptureLock) {
    console.log("already capturing image, aborting new request");
    return;
  }
  img_path = `/tmp/${img_name}`;
  var spawn = require('child_process').spawn;
  var proc;
  if(runningOnPi) {
    // capture the current image from the raspi camera
    var args = ["-n", "-w", "640", "-h", "480", "-hf", "-vf", "-o", "/tmp/garage-image.jpg", "-t", "0", "-tl", "500"];
    proc = spawn('raspistill', args);
  } else {
    // launch a raspistill process to continuously capture the current image
    console.log("[nopi] Using imagesnap instead of raspi native camera")
    var args = ["-w", "1.0", "-q", img_path];
    proc = spawn('imagesnap', args);
    proc.on('error', function(err) {
      console.log('WARN: No imagesnap binary available.  Ensure /tmp/garage-image.jpg exists.');
    });
  }

  proc.on('close', (code) => {
    console.log(`image capture process exited with code ${code}`);
    callback();
  });
}

function uploadNewImage(callback, img_name='garage-image.jpg', archive=false) {
  if(imageUploadLock) {
    console.log("already uploading image, aborting new request");
    return;
  }
  img_path = `/tmp/${img_name}`;
  bucketDest = archive ? "garage-image-archive/"+img_name : img_name;
  imageUploadLock = true;
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
            file.makePublic();
            callback();
          }
        }
      );
    } else if(err.code == 'ENOENT') {
        // file does not exist
        console.log("File " + img_path + " does not exist, skipping upload.")
        imageUploadLock = false;
    } else {
        console.log('Error looking for image file: ', err.code);
        imageUploadLock = false;
    }
    imageUploadLock = false;
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
  var docRef = firestoreDB.collection(collection).doc(doc_id);

  return firestoreDB.runTransaction(function(transaction) {
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

// Monitor Firestore for any pending door requests
firestoreDB.collection(doorCollection).where("status", "==", "pending")
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
        // Not sure if this will ever happen in practice.
        // If it does, we need to do something here.
        // Maybe notify me that there was an error?
        // Once this state is reached, the listener is dead and we'll
        // need to restart it somehow, app will be offline
    });

  // Monitor Firestore for any pending image requests
  firestoreDB.collection(imageCollection).where("status", "==", "pending")
      .onSnapshot(function(querySnapshot) {
          querySnapshot.forEach((doc) => {
              //console.log(`${doc.id} => ${JSON.stringify(doc.data(), null, 4)}`);
              uploadNewImage(function(error) {
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

// Start with a fresh image capture on boot.
captureNewImage(()=>{});

setInterval(() => { 
  console.log("capturing");
  let name = "new_image.jpg";
  captureNewImage(() => {
    uploadNewImage(() => {}, name, true);
  }, name);
}, 5000);

console.log("Janus Booted and ready to serve your garage door needs.")
