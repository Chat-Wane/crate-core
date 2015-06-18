
var Spray = require('spray-wrtc');
var CausalBroadcast = require('causal-broadcast-definition');
var VVwE = require('version-vector-with-exceptions');
var LSEQTree = require('lseqtree');
var GUID = require('./guid.js');

var MInsertOperation = require('./messages.js').MInsertOperation;
var MAEInsertOperation = require('./messages.js').MAEInsertOperation;
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
    // #A regular receive
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
    // #B anti-entropy for the missing operation
    this.broadcast.on('antiEntropy', function(socket, remoteVVwE, localVVwE){
        var remoteVVwE = (new VVwE(null)).fromJSON(remoteVVwE); // cast
        var toSearch = [];
        // #1 for each entry of our VVwE, look if the remote VVwE knows less
        for (var i=0; i<localVVwE.vector.arr.length; ++i){
            var localEntry = localVVwE.vector.arr[i];
            var index = remoteVVwE.vector.indexOf(localVVwE.vector.arr[i]);
            var start = 1;
            // #A check if the entry exists in the remote vvwe
            if (index >=0){ start = remoteVVwE.vector.arr[index].v + 1; };
            for (var j=start; j<=localEntry.v; ++j){
                // #B check if not one of the local exceptions
                if (localEntry.x.indexOf(j)<0){
                    toSearch.push({_e: localEntry.e, _c: j});
                };
            };
        };
        var elements = self.getElements(toSearch);
        // #2 send back the found elements
        self.broadcast.sendAntiEntropyResponse(socket, localVVwE, elements);
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

/*!
 * \brief search a set of elements in our sequence and return them
 * \param toSearch the array of elements {_e, _c} to search
 * \returns an array of nodes
 */
CrateCore.prototype.getElements = function(toSearch){
    var result = [], found, node, tempNode, i=0, j=0;
    // (TODO) improve research by exploiting the fact that if a node is
    // missing, all its children are missing too.
    // (TODO) improve the returned representation: either a tree to factorize
    // common parts of the structure or identifiers to get the polylog size
    // (TODO) improve the search by using the fact that toSearch is a sorted
    // array, possibly restructure this argument to be even more efficient
    while (toSearch.length > 0 && i<this.sequence.length){
        node = this.sequence.get(i+1);
        tempNode = node;
        while( tempNode.children.length > 0){
            tempNode = tempNode.children[0];
        };
        j = 0;
        found = false;
        while (j < toSearch.length && !found){
            if (tempNode.t.s === toSearch[j]._e &&
                tempNode.t.c === toSearch[j]._c){
                found = true;
                toSearch.splice(j,1);
                result.push(new MAEInsertOperation(node,
                                                   {_e: toSearch[j]._e,
                                                    _c:toSearch[j]._c} ));
            } else {
                ++j;
            };
        };
        ++i;
    };
    return result;
};

module.exports = CrateCore;
