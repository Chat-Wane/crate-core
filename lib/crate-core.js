
var Spray = require('spray-wrtc');
var CausalBroadcast = require('causal-broadcast-definition');
var VVwE = require('version-vector-with-exceptions');
var LSEQTree = require('lseqtree');
var GUID = require('./guid.js');

var MInsertOperation = require('./messages.js').MInsertOperation;
var MRemoveOperation = require('./messages.js').MRemoveOperation;

/*!
 * \brief link together all components of the model of the CRATE editor
 * \param id the unique site identifier
 * \param options the webrtc specific options 
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

/*!
 * \brief local insertion of a character inside the sequence structure. It
 * broadcasts the operation to the rest of the network.
 * \param character the character to insert in the sequence
 * \param index the index in the sequence to insert
 */
CrateCore.prototype.insert = function(character, index){
    var ei = this.sequence.insert(character, index);
    var id = ({ _e:ei._i._s[ei._i._s.length-1],
                _c:ei._i._c[ei._i._c.length-1]});
    this.broadcast(new MInsertMessage(ei), id, null);
};

/*!
 * \brief local deletion of a character from the sequence structure. It 
 * broadcasts the operation to the rest of the network.
 * \param index the index of the element to remove
 */
CrateCore.prototype.remove = function(index){
    var i = this.sequence.remove(index);
    this.broadcast(new MRemoveMessage(i), null, id);
};

/*!
 * \brief insertion of an element from a remote site. It emits 'remoteInsert' 
 * with the index of the element to insert, -1 if already existing.
 * \param ei the result of the remote insert operation
 */
CrateCore.prototype.remoteInsert = function(ei){
    this.emit('remoteInsert', this.sequence.applyInsert(ei._e, ei._i));
};

/*!
 * \brief removal of an element from a remote site.  It emits 'remoteRemove'
 * with the index of the element to remove, -1 if does not exist
 * \param id the result of the remote insert operation
 */
CrateCore.prototype.remoteRemove = function(id){
    this.emit('remoteRemove', this.sequence.applyRemove(id));
};

module.exports = CrateCore;
