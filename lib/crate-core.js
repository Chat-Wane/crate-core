var Spray = require('spray-wrtc');
var CausalBroadcast = require('causal-broadcast-definition');
var VVwE = require('version-vector-with-exceptions');
var LSEQTree = require('lseqtree');
var GUID = require('./guid.js');

var MInsertOperation = require('./messages.js').MInsertOperation;
var MRemoveOperation = require('./messages.js').MRemoveOperation;

/*!
 * \brief link together all components of the model of the CRATE editor
 */
function CrateCore(id, options){
    this.id = id || GUID();
    this.broadcast = new CausalBroadcast(new Spray(id, options), new VVwE(id));
    this.sequence = new LSEQTree(id);

    var self = this;
    this.broadcast.on('receive', function(receivedBroadcastMessage){
        switch (receivedBroadcastMessage.type){
        case 'MRemoveMessage':
            self.remoteRemove(receivedBroadcastMessage.remove);
            break;
        case 'MInsertMessage':
            self.remoteInsert(receivedBroadcastMessage.insert);
            break;
        };
    });
};

CrateCore.prototype.insert = function(character, index){
    var ei = this.sequence.insert(character, index);
    var id = ({ _e:ei._i._s[ei._i._s.length-1],
                _c:ei._i._c[ei._i._c.length-1]});
    this.broadcast(new MInsertMessage(ei), id, null);
};

CrateCore.prototype.remove = function(index){
    var i = this.sequence.remove(index);
    this.broadcast(new MRemoveMessage(i), null, id);
};

CrateCore.prototype.remoteInsert = function(ei){
    this.emit('remoteInsert', this.sequence.applyInsert(ei._e, ei._i));
};

CrateCore.prototype.remoteRemove = function(id){
    this.emit('remoteRemove', this.sequence.applyRemove(id));
};

module.exports = CrateCore;
