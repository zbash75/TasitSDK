import Contract from "./Contract";
import Account from "tasit-account";

// Note: SimpleStorage.json is originally genarated by `tasit-contracts` and was pasted here manually
// See https://github.com/tasitlabs/TasitSDK/issues/45
import { abi as contractABI } from "./testHelpers/SimpleStorageWithRemoved.json";

// Note: Under the current `tasit-contracts` setup SimpleStorageWithRemoved aways will deployed with this address
// See https://github.com/tasitlabs/TasitSDK/issues/138
const contractAddress = "0x6C4A015797DDDd87866451914eCe1e8b19261931";

describe("TasitAction.Contract", () => {
  let simpleStorage,
    wallet,
    testcaseSnaphotId,
    provider,
    txSubscription,
    contractSubscription;

  beforeEach("should connect to an existing contract", async () => {
    if (contractSubscription) {
      expect(contractSubscription.subscribedEventNames()).to.be.empty;
    }

    if (txSubscription) {
      expect(txSubscription.subscribedEventNames()).to.be.empty;
    }

    simpleStorage = undefined;
    wallet = undefined;
    testcaseSnaphotId = undefined;
    provider = undefined;
    txSubscription = undefined;
    contractSubscription = undefined;

    // Account creates a wallet, should it create an account object that encapsulates the wallet?
    // TasitAcount.create()
    // > Acount { wallet: ..., metaTxInfos..., etc }
    wallet = createFromPrivateKey(
      "0x11d943d7649fbdeb146dc57bd9cfc80b086bfab2330c7b25651dbaf382392f60"
    );

    simpleStorage = new Contract(contractAddress, contractABI);
    expect(simpleStorage).to.exist;
    expect(simpleStorage.getAddress()).to.equal(contractAddress);
    expect(simpleStorage.getValue).to.exist;
    expect(simpleStorage.setValue).to.exist;
    expect(simpleStorage.getProvider()).to.exist;

    provider = simpleStorage.getProvider();
    testcaseSnaphotId = await createSnapshot(provider);
  });

  afterEach("revert blockchain snapshot", async () => {
    await mineBlocks(provider, 1);

    if (contractSubscription) {
      contractSubscription.unsubscribe();

      expect(
        contractSubscription.getEmitter()._events,
        "ethers.js should not be listening to any events."
      ).to.be.empty;
    }

    if (txSubscription) {
      await txSubscription.waitForNonceToUpdate();
      txSubscription.unsubscribe();

      expect(
        txSubscription.getEmitter()._events,
        "ethers.js should not be listening to any events."
      ).to.be.empty;
    }

    await revertFromSnapshot(provider, testcaseSnaphotId);
  });

  describe("should throw error when instantiated with invalid args", () => {
    it("constructor without address and ABI", async () => {
      expect(() => {
        new Contract();
      }).to.throw();
    });

    it("constructor without ABI", async () => {
      expect(() => {
        new Contract(contractAddress);
      }).to.throw();
    });

    it("constructor without address but with ABI", async () => {
      expect(() => {
        new Contract(null, contractABI);
      }).to.throw();
    });

    it("constructor with invalid address and valid ABI", async () => {
      expect(() => {
        new Contract("invalid address", contractABI);
      }).to.throw();
    });

    it("constructor with valid address and invalid ABI", async () => {
      expect(() => {
        new Contract(contractAddress, "invalid abi");
      }).to.throw();
    });
  });

  it("should call a read-only contract method", async () => {
    const value = await simpleStorage.getValue();
    expect(value).to.exist;
  });

  describe("wallet/account setup tests", async () => {
    it("should throw error when setting a wallet with no wallet argument", async () => {
      expect(() => {
        simpleStorage.setWallet();
      }).to.throw();
    });

    it("should throw error when setting invalid wallet", async () => {
      expect(() => {
        simpleStorage.setWallet("invalid wallet");
      }).to.throw();
    });

    it("should throw error when calling write method without account/wallet", async () => {
      expect(() => {
        simpleStorage.setValue("hello world");
      }).to.throw();
    });

    it("should throw error when calling write method after account/wallet removal", async () => {
      simpleStorage.setWallet(wallet);
      simpleStorage.removeWallet();
      expect(() => {
        simpleStorage.setValue("hello world");
      }).to.throw();
    });
  });

  describe("TransactionSubscription - actions (tx) subscriptions tests", async () => {
    let rand;

    beforeEach("assign a wallet to the contract", () => {
      expect(() => {
        simpleStorage.setWallet(wallet);
      }).not.to.throw();

      rand = Math.floor(Math.random() * Math.floor(1000)).toString();
    });

    it("should throw when subscribing with invalid event name", async () => {
      txSubscription = simpleStorage.setValue("hello world");

      expect(() => {
        txSubscription.on("invalid", () => {});
      }).to.throw();
    });

    it("should throw when subscribing without listener", async () => {
      txSubscription = simpleStorage.setValue("hello world");

      expect(() => {
        txSubscription.on("confirmation");
      }).to.throw();
    });

    it("should change contract state and trigger confirmation event one time", async () => {
      txSubscription = simpleStorage.setValue(rand);

      // Waiting for 1st confirmation
      // For now ganache always mine a block after transaction creation
      // To avoid non-determinism it's recommended to wait that first confirmation if it could affect the test case result
      // See more: https://github.com/trufflesuite/ganache-core/issues/248#issuecomment-455354557
      await txSubscription.waitForNonceToUpdate();

      const confirmationFakeFn = sinon.fake();
      const errorFakeFn = sinon.fake();

      const errorListener = message => {
        const { error, eventName } = message;
        errorFakeFn();
      };

      const confirmationListener = async message => {
        const { data } = message;
        const { confirmations } = data;

        confirmationFakeFn();

        const value = await simpleStorage.getValue();
        expect(value).to.equal(rand);
      };

      txSubscription.on("error", errorListener);

      txSubscription.once("confirmation", confirmationListener);

      await mineBlocks(provider, 2);

      expect(confirmationFakeFn.callCount).to.equal(1);
      expect(errorFakeFn.called).to.be.false;

      txSubscription.off("error");

      expect(txSubscription.subscribedEventNames()).to.be.empty;
    });

    it("should change contract state and trigger confirmation event", async () => {
      txSubscription = simpleStorage.setValue(rand);

      await txSubscription.waitForNonceToUpdate();

      const confirmationFakeFn = sinon.fake();
      const errorFakeFn = sinon.fake();

      const errorListener = message => {
        errorFakeFn();
      };

      const confirmationListener = async message => {
        const { data } = message;
        const { confirmations } = data;

        if (confirmations >= 7) {
          txSubscription.off("confirmation");

          const value = await simpleStorage.getValue();
          expect(value).to.equal(rand);
        }
        confirmationFakeFn();
      };

      txSubscription.on("error", errorListener);
      txSubscription.on("confirmation", confirmationListener);

      await mineBlocks(provider, 6);

      expect(confirmationFakeFn.callCount).to.equal(6);
      expect(errorFakeFn.called).to.be.false;
    });

    it("should change contract state and trigger confirmation event - late subscription", async () => {
      txSubscription = simpleStorage.setValue(rand);

      await txSubscription.waitForNonceToUpdate();

      await mineBlocks(provider, 5);

      const confirmationFakeFn = sinon.fake();
      const errorFakeFn = sinon.fake();

      const errorListener = message => {
        errorFakeFn();
      };

      const confirmationListener = async message => {
        const { data } = message;
        const { confirmations } = data;

        if (confirmations == 7) {
          txSubscription.off("confirmation");

          const value = await simpleStorage.getValue();
          expect(value).to.equal(rand);

          confirmationFakeFn();
        }
      };

      txSubscription.on("error", errorListener);
      txSubscription.on("confirmation", confirmationListener);

      await mineBlocks(provider, 2);

      expect(confirmationFakeFn.called).to.be.true;
      expect(confirmationFakeFn.callCount).to.equal(1);
      expect(errorFakeFn.called).to.be.false;
    });

    it("should call error listener after timeout", async () => {
      txSubscription = simpleStorage.setValue("hello world");
      txSubscription.setEventsTimeout(100);

      await txSubscription.waitForNonceToUpdate();

      const errorFn = sinon.fake();
      const confirmationFn = sinon.fake();

      const foreverListener = message => {
        confirmationFn();
      };

      txSubscription.on("confirmation", foreverListener);

      const errorListener = message => {
        const { error, eventName } = message;
        expect(error.message).to.equal("Event confirmation reached timeout.");
        errorFn();
      };

      txSubscription.on("error", errorListener);

      await mineBlocks(provider, 1);

      // TODO: Use fake timer when Sinon/Lolex supports it.
      // See more:
      //  https://github.com/sinonjs/sinon/issues/1739
      //  https://github.com/sinonjs/lolex/issues/114
      //  https://stackoverflow.com/a/50785284
      await wait(txSubscription.getEventsTimeout() * 3);

      expect(errorFn.called).to.be.true;
      expect(confirmationFn.called).to.be.true;
      expect(txSubscription.subscribedEventNames()).to.deep.equal([
        "confirmation",
        "error",
      ]);
    });

    it("subscription should have one listener per event", async () => {
      txSubscription = simpleStorage.setValue("hello world");

      const listener1 = message => {};
      const listener2 = message => {};

      expect(txSubscription.subscribedEventNames()).to.be.empty;

      txSubscription.on("confirmation", listener1);

      expect(() => {
        txSubscription.on("confirmation", listener2);
      }).to.throw();

      expect(txSubscription.subscribedEventNames()).to.deep.equal([
        "confirmation",
      ]);
    });

    it("should remove an event", async () => {
      txSubscription = simpleStorage.setValue("hello world");

      const listener1 = message => {};

      expect(txSubscription.subscribedEventNames()).to.be.empty;

      txSubscription.on("confirmation", listener1);

      expect(txSubscription.subscribedEventNames()).to.deep.equal([
        "confirmation",
      ]);

      txSubscription.off("confirmation");

      expect(txSubscription.subscribedEventNames()).to.be.empty;
    });

    // Note: Block reorganization is the situation where a client discovers a
    //  new difficultywise-longest well-formed blockchain which excludes one or more blocks that
    //  the client previously thought were part of the difficultywise-longest well-formed blockchain.
    //  These excluded blocks become orphans.
    it("should emit error event when block reorganization occurs - block excluded", async () => {
      const confirmationFn = sinon.fake();
      const errorFn = sinon.fake();

      const confirmationListener = message => {
        confirmationFn();
      };

      const errorListener = message => {
        const { error, eventName } = message;

        // Note: This assertion will not fail the test case (UnhandledPromiseRejectionWarning)
        expect(error.message).to.equal(
          "Your action's position in the chain has changed in a surprising way."
        );

        // But asserting fake function, if that throws, test case will fail.
        errorFn();
      };

      const snapshotId = await createSnapshot(provider);

      txSubscription = simpleStorage.setValue("hello world");

      txSubscription.on("confirmation", confirmationListener);

      txSubscription.on("error", errorListener);

      await mineBlocks(provider, 2);

      expect(confirmationFn.called).to.be.true;

      await revertFromSnapshot(provider, snapshotId);

      await mineBlocks(provider, 2);

      // Note: Transaction no longer exists
      // If it isn't unset, afterEach hook will execute waitForNonceToUpdate forever
      txSubscription.off("confirmation");
      txSubscription = undefined;

      expect(errorFn.called).to.be.true;
    });

    // Note: Block reorganization is the situation where a client discovers a
    //  new difficultywise-longest well-formed blockchain which excludes one or more blocks that
    //  the client previously thought were part of the difficultywise-longest well-formed blockchain.
    //  These excluded blocks become orphans.
    it("should emit error event when block reorganization occurs - tx confirmed twice", async () => {
      const confirmationFn = sinon.fake();
      const errorFn = sinon.fake();

      const confirmationListener = message => {
        confirmationFn();
      };

      const errorListener = message => {
        const { error, eventName } = message;

        // Note: This assertion will not fail the test case (UnhandledPromiseRejectionWarning)
        expect(error.message).to.equal(
          "Your action's position in the chain has changed in a surprising way."
        );

        // But asserting fake function, if that throws, test case will fail.
        errorFn();
      };

      txSubscription = simpleStorage.setValue("hello world");

      await txSubscription.waitForNonceToUpdate();

      txSubscription.on("error", errorListener);

      txSubscription.on("confirmation", confirmationListener);

      await mineBlocks(provider, 1);

      const snapshotId = await createSnapshot(provider);

      await mineBlocks(provider, 2);

      expect(confirmationFn.called).to.be.true;

      await revertFromSnapshot(provider, snapshotId);

      // Note: Without that, ethers.provider will keep the same
      // receipt.confirmations as before snapshot reversion
      txSubscription.refreshProvider();

      await mineBlocks(provider, 2);

      // not always on the first new block because of pollingInterval vs blockTime issue
      // but the first poll after that 15 new blocks is emitting error event
      expect(errorFn.called).to.be.true;
    });
  });

  describe("ContractSubscription - contract events subscription", async () => {
    beforeEach("assign a wallet to the contract", () => {
      expect(() => {
        simpleStorage.setWallet(wallet);
      }).not.to.throw();
    });

    it("should trigger an event one time when you're listening to that event and the contract triggers it", async () => {
      contractSubscription = simpleStorage.subscribe();
      const fakeFn = sinon.fake();
      const errorFakeFn = sinon.fake();

      const errorListener = message => {
        const { error, eventName } = message;
        errorFakeFn();
      };

      contractSubscription.on("error", errorListener);

      txSubscription = simpleStorage.setValue("hello world");

      // Is possible do that using async/await?
      // If not, TODO: Make a function
      await new Promise(function(resolve, reject) {
        contractSubscription.once("ValueChanged", message => {
          const { data } = message;
          const { args } = data;

          fakeFn();

          resolve();
        });
      });

      contractSubscription.off("error");

      expect(errorFakeFn.called).to.be.false;
      expect(fakeFn.callCount).to.equal(1);
      expect(contractSubscription.subscribedEventNames()).to.be.empty;
    });

    it("should be able to listen to an event triggered by the contract", async () => {
      contractSubscription = simpleStorage.subscribe();
      const fakeFn = sinon.fake();
      const errorFakeFn = sinon.fake();

      const errorListener = message => {
        const { error, eventName } = message;
        errorFakeFn();
      };

      contractSubscription.on("error", errorListener);

      txSubscription = simpleStorage.setValue("hello world");

      // Is possible do that using async/await?
      // If not, TODO: Make a function
      await new Promise(function(resolve, reject) {
        contractSubscription.on("ValueChanged", message => {
          const { data } = message;
          const { args } = data;

          fakeFn();
          resolve();
        });
      });

      contractSubscription.off("error");

      expect(errorFakeFn.called).to.be.false;
      expect(fakeFn.callCount).to.equal(1);
    });

    it("should throw error when listening on invalid event", async () => {
      contractSubscription = simpleStorage.subscribe();

      expect(() => {
        contractSubscription.on("InvalidEvent", () => {});
      }).to.throw();
    });

    it("subscription should have one listener per event", async () => {
      contractSubscription = simpleStorage.subscribe();

      const listener1 = message => {};
      const listener2 = message => {};

      expect(contractSubscription.subscribedEventNames()).to.be.empty;

      contractSubscription.on("ValueChanged", listener1);

      expect(() => {
        contractSubscription.on("ValueChanged", listener2);
      }).to.throw();

      expect(contractSubscription.subscribedEventNames()).to.deep.equal([
        "ValueChanged",
      ]);
    });

    it("should remove an event", async () => {
      contractSubscription = simpleStorage.subscribe();

      const listener1 = message => {};

      expect(contractSubscription.subscribedEventNames()).to.be.empty;

      contractSubscription.on("ValueChanged", listener1);

      expect(contractSubscription.subscribedEventNames()).to.deep.equal([
        "ValueChanged",
      ]);

      contractSubscription.off("ValueChanged");

      expect(contractSubscription.subscribedEventNames()).to.be.empty;
    });

    it("should manage many listeners", async () => {
      contractSubscription = simpleStorage.subscribe();

      const listener1 = message => {};
      const listener2 = message => {};
      const listener3 = message => {};

      expect(contractSubscription.subscribedEventNames()).to.be.empty;

      contractSubscription.on("ValueChanged", listener1);
      contractSubscription.on("ValueRemoved", listener2);

      expect(contractSubscription.subscribedEventNames()).to.deep.equal([
        "ValueChanged",
        "ValueRemoved",
      ]);

      contractSubscription.off("ValueRemoved");

      expect(contractSubscription.subscribedEventNames()).to.deep.equal([
        "ValueChanged",
      ]);

      contractSubscription.on("ValueRemoved", listener3);

      expect(contractSubscription.subscribedEventNames()).to.deep.equal([
        "ValueChanged",
        "ValueRemoved",
      ]);

      contractSubscription.unsubscribe();

      expect(contractSubscription.subscribedEventNames()).to.be.empty;
    });
  });

  // Send method interface: Contract.send(tx: msg, bool: free) => Subscription
  // On free send how know if identity-contract should be used?
  it.skip("should send a signed message", async () => {});
});