const async = require("async");
const BN = require("bn.js");
const EstimationModel = require("../database/models/accountEstimationModel");

const timeout = ms => new Promise(resolve => setTimeout(resolve, ms));
async function trigger(fn, ms) {
    await timeout(ms);
    await fn.drain("Empty queue");
}

const estimationQueue = async.queue(async function(task) {
    console.log('estimationQueue');
    const accountEstimationDate = await task.self.liquidationDate(task.token, task.account);
    try {
        await EstimationModel.upsert({
            address: task.account,
            superToken: task.token,
            zestimation: accountEstimationDate == "Invalid Date" ? -1 : new Date(accountEstimationDate).getTime(),
            zestimationHuman : accountEstimationDate,
            zlastChecked: task.self.app.getTimeUnix(),
            found: 0,
            now: (accountEstimationDate == -1 ? true: false),
        });
    } catch(error) {
        console.debug("saving estimation model error");
        console.error(error);
    }
}, 1);

estimationQueue.drain(function() {
    console.log('all items have been processed');
});

estimationQueue.error(function(err, task) {
    console.debug(`task error: ${task}`);
    console.error(error);
});

const agreementUpdateQueue = async.queue(async function(task) {
    console.log('agreementUpdateQueue');
    //task.self.getSuperTokenEvent(task.token, "");
}, 1);

class Protocol {

    constructor(app) {
        this.app = app;
        this.client = this.app.client;
        this.subs = new Map();
    }

    async getAccountRealtimeBalance(token, address, timestamp) {
        try {
            if(timestamp === undefined) {
                timestamp = Math.floor(new Date().getTime() / 1000);
            }
            return this.client.superTokens[token].methods.realtimeBalanceOf(
                address,
                timestamp
            ).call();
        } catch(error) {
            console.error(error)
        }
    }

    async getAccountAgreementRealtimeBalance(token, account, timestamp) {
        try {
            if(timestamp === undefined) {
                timestamp = Math.floor(new Date().getTime() / 1000);
            }
            return this.client.CFAv1.methods.realtimeBalanceOf(
                token,
                account,
                timestamp
            ).call();
        } catch(error) {
            console.error(error)
        }
    }

    async getUserNetFlow(token, account) {
        try {
            return this.client.CFAv1.methods.getNetFlow(token, account).call();
        } catch(error) {
            console.log(error);
        }
    }

    async getAgreementEvents(eventName, filter) {
        return this.client.CFAv1.getPastEvents(eventName, filter);
    }

    getLastFlowUpdated(filter) {
        return this.getLastFlowUpdated(
            this.getAgreementEvents("FlowUpdated", filter)
        );
    }

    getLatestFlows(flows) {
        return Object.values(flows.reduce((acc, i) => {
            acc[i.args.sender + ":" + i.args.receiver] = i;
            return acc;
        }, {})).filter(i => i.args.flowRate.toString() != "0");
    }

    getAllSuperTokensEvents(eventName, filter) {
        const keys = Object.keys(this.client.getSuperTokenInstances());
        const arrPromise = new Array();
        for(const key of keys){
            arrPromise.push(
                this.client.superTokens[key].getPastEvents(eventName, filter)
            )
        }
        return arrPromise.flat();
    }

    async liquidationDate(token, account) {
        const now = Math.floor(new Date().getTime() / 1000);
        let arrPromise = [
            this.getUserNetFlow(token, account),
            this.getAccountRealtimeBalance(token,account,now),
            this.getAccountAgreementRealtimeBalance(token, account,now)
        ];
        arrPromise = await Promise.all(arrPromise);
        return this._getLiquidationDate(
            new BN(arrPromise[0]),
            new BN(arrPromise[1].availableBalance),
            new BN(arrPromise[2].deposit)
        );
    }

    async run(fn, time) {
        await trigger(fn, time);
        await this.run(fn, time);
    }

    async subscribeAllTokensEvents() {
        this.run(estimationQueue, 1000);
        const superTokenInstances = this.client.getSuperTokenInstances();
        for(let key of Object.keys(superTokenInstances)) {
            this.subscribeEvents(key);
        }
    }

    async subscribeEvents(token) {
        const superToken = this.client.superTokens[token];
        this.app.logger.log("starting listen superToken: " + token);
        this.subs.set(token,
            superToken.events.allEvents(
            async(err, evt) => {
                if(err === undefined || err == null) {
                    this.app.logger.log(evt.event);
                    let event = this.app.models.event.transformWeb3Event(evt);
                    console.log(event);
                    switch(evt.eventName) {

                        case "AgreementStateUpdated" : {
                            agreementUpdateQueue.push({
                                account: event.account,
                                blockNumber: event.blockNumber
                            });
                            break;
                        }
                        case "TokenUpgraded" :
                        case "TokenDowngraded" : {
                            estimationQueue.push({
                                self: this,
                                account: event.account,
                                superToken: event.address
                            });
                            break;
                        }
                        case "Transfer" : {
                            console.log("adding to queue");
                            estimationQueue.push([
                                {
                                    self: this,
                                    account: event.from,
                                    superToken: event.address
                                },
                                {
                                    self: this,
                                    account: event.to,
                                    superToken: event.address
                                }
                            ]);
                            break;
                        }
                        }
                } else {
                    console.error(err);
                }
            })
        );
    }

    async subscribeAgreementEvents() {
        const CFA = this.client.CFAv1WS;
        this.app.logger.log("starting listen CFAv1: " + CFA._address);
        CFA.events.FlowUpdated(async(err, evt) => {
                if(err === undefined || err == null) {
                    this.app.logger.log(evt.event);
                    let event = this.app.models.event.transformWeb3Event(evt);
                    if(this.client.superTokens[event.token] === undefined) {
                        console.debug("Found new token: ", event.token);
                        await this.client.loadSuperToken(event.token);
                        setTimeout(() => subscribeEvents(token), 1000);
                        estimationQueue.push([
                            {
                                self: this,
                                account: event.sender,
                                superToken: event.token
                            },
                            {
                                self: this,
                                account: event.receiver,
                                superToken: event.token
                            }
                        ]);
                        agreementUpdateQueue.push([
                            {
                                self: this,
                                account: event.sender,
                                blockNumber: event.blockNumber
                            },
                            {
                                self: this,
                                account: event.receiver,
                                blockNumber: event.blockNumber
                            }
                        ]);
                    }
                } else {
                    console.error(err);
                }
            });
    }

    generateId(sender, receiver) {
        return this.client.web3.utils.soliditySha3(sender, receiver);
    }

    _getLiquidationDate(totalNetFlowRate, totalBalance, totalDeposit) {
        if(totalNetFlowRate.lt(new BN(0))) {
            if(totalBalance.add(totalDeposit).lt(new BN(0))) {
                return -1;
            } else {
                let seconds = totalBalance.div(totalNetFlowRate);
                seconds = isFinite(seconds) ? seconds : 0;
                let secondsX = Math.abs(isNaN(seconds) ? 0 : seconds);
                secondsX = Math.round(secondsX);
                let estimation = new Date();
                return new Date(estimation.setSeconds(secondsX));
            }
        }

        return new Date(0);
    }
}

module.exports = Protocol;