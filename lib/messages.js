/*!
 * \brief object that represents the result of an insert operation
 * \param insert the result of the local insert operation
 */
function MInsertOperation(insert){
    this.type = "MInsertOperation";
    this.insert = insert;
};
module.exports.MInsertOperation = MInsertOperation;

function MAEInsertOperation(insert, id){
    this.type = "MAEInsertOperation";
    this.payload = new MInsertOperation(insert);
    this.id = id;
    this.isReady = null;
};
module.exports.MAEInsertOperation = MAEInsertOperation;

/*!
 * \brief object that represents the result of a delete operation
 * \param remove the result of the local delete operation
 */
function MRemoveOperation(remove){
    this.type = "MRemoveOperation";
    this.remove = remove;
};
module.exports.MRemoveOperation = MRemoveOperation;

/*!
 * \brief object that represents the result of a caretMoved Operation
 * \param remove the result of the local caretMoved Operation
 */
function MCaretMovedOperation(caretMoved){
    this.type = "MCaretMovedOperation";
    this.caretMoved = caretMoved;
};
module.exports.MCaretMovedOperation = MCaretMovedOperation;