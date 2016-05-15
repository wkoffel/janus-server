SCRIPT=`realpath $0`
SCRIPTPATH=`dirname $SCRIPT`
cd $SCRIPTPATH
TZ='America/New_York' node ./janus-server.js >> janus-server.log 2>&1

