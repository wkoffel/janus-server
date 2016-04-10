require('dotenv').config();

var AWS = require('aws-sdk');
var accessKey = process.env.AWS_ACCESS_KEY;
var secretKey = process.env.AWS_SECRET_KEY;
AWS.config.update({accessKeyId: accessKey, secretAccessKey: secretKey});
var s3 = new AWS.S3({apiVersion: '2006-03-01'});

const fs = require('fs');

var pubnub = require("pubnub")({
    ssl           : true,  // <- enable TLS Tunneling over TCP
    publish_key   : process.env.PN_PUB_KEY,
    subscribe_key : process.env.PN_SUB_KEY
});

function uploadNewImage() {
  // upload and then notify
  stream = fs.createReadStream('/tmp/garage-image.jpg')
  var params = {
    Bucket: 'clearlytech',
    Key: 'garage-image.jpg',
    Body: stream,
    ContentType: 'image/jpg',
    ACL: 'public-read'
  };
  s3.putObject(params, function(err, data) {
    if(err) {
      console.log("Error uploading image.", err, data);
    } else {
      notifyNewImage("garage-image.jpg")
    }
  });
}

function notifyNewImage(imageKey) {
  pubnub.publish({
      channel   : 'image_ready',
      message   : {"url" : imageKey},
      error     : function(e) { console.log( "Failed to send image_ready notification.", e ); }
  });
}

/* ---------------------------------------------------------------------------
Listen for Messages
--------------------------------------------------------------------------- */
pubnub.subscribe({
    channel  : "capture_image",
    callback : function(message) {
      console.log( " > ", message );
      uploadNewImage();
    }
});
