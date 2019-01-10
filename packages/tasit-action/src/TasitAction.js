import "ethers/dist/shims.js";
// Note: ethers SHOULD be imported from their main object
// shims aren't injected with package import
import { ethers } from "ethers";
const config = require("config");

class Utils {
  static isAddress = address => {
    return typeof address === "string" && address.match(/^0x[0-9A-Fa-f]{40}$/);
  };

  static isABI = abi => {
    return abi && Array.isArray(abi);
  };

  // https://github.com/ethers-io/ethers.js/blob/db383a3121bb8cf5c80c5488e853101d8c1df353/src.ts/utils/properties.ts#L20
  static isEthersJsSigner = signer => {
    return signer && signer._ethersType === "Signer";
  };
}

class Subscription {
  #emitter;
  #events = [];

  constructor(eventEmitter) {
    this.#emitter = eventEmitter;
  }

  removeListener = (eventName, listener) => {
    this.#events = this.#events.filter(event => {
      if (event.eventName === eventName && event.listener === listener) {
        this.#emitter.removeListener(
          event.wrappedEventName,
          event.wrappedListener
        );
        return false;
      }
      return true;
    });
  };

  off = (eventName, listener) => {
    this.removeListener(eventName, listener);
  };

  listenerCount = eventName => {
    return this.#events.filter(event => {
      return event.eventName === eventName;
    }).length;
  };

  removeAllListeners = () => {
    this.#events.forEach(event => {
      this.removeListener(event.eventName, event.listener);
    });
  };

  unsubscribe = () => {
    this.removeAllListeners();
  };

  // TODO: Make protected
  emitErrorEvent = error => {
    this.#events.forEach(event => {
      if (event.eventName === "error") {
        event.listener(error);
      }
    });
  };

  // TODO: Make protected
  addErrorListener = listener => {
    const eventName = "error";
    this.#events.push({
      eventName,
      wrappedEventName: eventName,
      listener,
      wrappedListener: listener,
    });
  };

  // TODO: Make protected
  addListener = (eventName, wrappedEventName, listener, wrappedListener) => {
    this.#emitter.on(wrappedEventName, wrappedListener);

    this.#events.push({
      eventName,
      wrappedEventName,
      listener,
      wrappedListener,
    });
  };
}

class TransactionSubscription extends Subscription {
  #txPromise;
  #provider;
  #tx;
  #txConfirmed = false;

  constructor(txPromise, provider) {
    // Provider implements EventEmitter API and it's enough
    //  to handle with transactions events
    super(provider);
    this.#txPromise = txPromise;
    this.#provider = provider;
  }

  #addConfirmationListener = async listener => {
    const eventName = "confirmation";
    this.#tx = await this.#txPromise;

    const wrappedListener = async blockNumber => {
      try {
        const receipt = await this.#provider.getTransactionReceipt(
          this.#tx.hash
        );

        if (receipt !== null) {
          this.#txConfirmed = true;
        } else {
          if (this.#txConfirmed)
            this.emitErrorEvent(
              new Error(`Your message has been included in an uncle block.`)
            );

          return;
        }

        const { confirmations } = receipt;
        const message = {
          data: {
            confirmations: confirmations,
          },
        };

        await listener(message);
      } catch (error) {
        this.emitErrorEvent(
          new Error(`Callback function with error: ${error.message}`)
        );
      }
    };

    this.addListener(eventName, "block", listener, wrappedListener);

    setTimeout(() => {
      this.emitErrorEvent(
        new Error(
          `Listener removed after reached timeout - event took too long.`
        )
      );
      this.removeListener(eventName, listener);
    }, config.events.timeout);
  };

  on = async (eventName, listener) => {
    const triggers = ["confirmation", "error"];

    if (!triggers.includes(eventName)) {
      throw new Error(`Invalid listener trigger, use: [${triggers}]`);
    }

    if (!listener || typeof listener !== "function") {
      throw new Error(`Cannot listen without a function`);
    }

    if (eventName === "error") {
      this.addErrorListener(listener);
    } else if (eventName === "confirmation") {
      await this.#addConfirmationListener(listener);
    }
  };

  // Tech debt
  // This method avoids duplicated nonce generation when several transactions happen in rapid succession
  // See: https://github.com/ethereumbook/ethereumbook/blob/04f66ae45cd9405cce04a088556144be11979699/06transactions.asciidoc#keeping-track-of-nonces
  // How we'll should keeping track of nonces?
  waitForNonceToUpdate = async () => {
    const tx = await this.#txPromise;
    await this.#provider.waitForTransaction(tx.hash);
  };
}

class ContractSubscription extends Subscription {
  #contract;

  // Note: We're considering listening multiple events at once
  //    adding eventName, listener params to constructor.
  constructor(contract) {
    super(contract);
    this.#contract = contract;
  }

  on = (eventName, listener) => {
    if (
      eventName !== "error" &&
      this.#contract.interface.events[eventName] === undefined
    )
      throw new Error(`Event '${eventName}' not found.`);

    if (eventName === "error") {
      this.addErrorListener(listener);
      return;
    }

    const wrappedListener = async (...args) => {
      // Note: This depends on the current ethers.js specification of contract events to work:
      // "All event callbacks receive the parameters specified in the ABI as well as
      // one additional Event Object"
      // https://docs.ethers.io/ethers.js/html/api-contract.html#event-object
      // TODO: Consider checking that the event looks like what we expect and
      // erroring out if not
      const event = args.pop();

      const message = {
        data: {
          args: event.args,
        },
      };

      try {
        await listener(message);
      } catch (error) {
        this.emitErrorEvent(
          new Error(`Callback function with error: ${error.message}`)
        );
      }
    };

    this.addListener(eventName, eventName, listener, wrappedListener);
  };
}

class ProviderFactory {
  static getProvider = () => {
    const { provider } = config;
    const json = provider;
    return ProviderFactory.createProvider(json);
  };

  static getDefaultConfig = () => {
    return {
      network: "mainnet",
      provider: "fallback",
      pollingInterval: 4000,
      jsonRpc: {
        url: "http://localhost",
        port: 8545,
        allowInsecure: false,
      },
    };
  };

  static createProvider = ({
    network,
    provider,
    pollingInterval,
    jsonRpc,
    infura,
    etherscan,
  }) => {
    const networks = ["mainnet", "rinkeby", "ropsten", "kovan", "other"];
    const providers = ["default", "infura", "etherscan", "jsonrpc"];

    if (!networks.includes(network)) {
      throw new Error(`Invalid network, use: [${networks}].`);
    }

    if (!providers.includes(provider)) {
      throw new Error(`Invalid provider, use: [${providers}].`);
    }

    if (provider === "fallback") network = "default";
    if (network === "mainnet") network = "homestead";
    else if (network === "other") network = undefined;

    const defaultConfig = ProviderFactory.getDefaultConfig();

    let ethersProvider;

    switch (provider) {
      case "default":
        ethersProvider = ethers.getDefaultProvider(network);

      case "infura":
        ethersProvider = new ethers.providers.InfuraProvider(
          network,
          infura.apiKey
        );

      case "etherscan":
        ethersProvider = new ethers.providers.EtherscanProvider(
          network,
          etherscan.apiKey
        );

      case "jsonrpc":
        let { url, port, user, password, allowInsecure } = jsonRpc;
        if (url === undefined) url = defaultConfig.jsonRpc.url;
        if (port === undefined) port = defaultConfig.jsonRpc.port;
        if (allowInsecure === undefined)
          allowInsecure = defaultConfig.jsonRpc.allowInsecure;

        ethersProvider = new ethers.providers.JsonRpcProvider(
          { url: `${url}:${port}`, user, password, allowInsecure },
          network
        );
    }

    if (pollingInterval) ethersProvider.pollingInterval = pollingInterval;
    return ethersProvider;
  };
}

export class Contract {
  #provider;
  #contract;

  constructor(address, abi, wallet) {
    this.#provider = ProviderFactory.getProvider();
    this.#initializeContract(address, abi, wallet);
  }

  // Note: For now, `tasit-account` creates a ethers.js wallet object
  // If that changes, maybe this method could be renamed to setAccount()
  setWallet = wallet => {
    if (!Utils.isEthersJsSigner(wallet))
      throw new Error(`Cannot set an invalid wallet for a Contract`);

    this.#initializeContract(
      this.#contract.address,
      this.#contract.interface.abi,
      wallet
    );
  };

  removeWallet = () => {
    this.#initializeContract(
      this.#contract.address,
      this.#contract.interface.abi
    );
  };

  getAddress = () => {
    return this.#contract.address;
  };

  // For testing purposes
  getProvider = () => {
    return this.#provider;
  };

  subscribe = () => {
    const subscription = new ContractSubscription(this.#contract);
    return subscription;
  };

  #initializeContract = (address, abi, wallet) => {
    if (!Utils.isAddress(address) || !Utils.isABI(abi))
      throw new Error(`Cannot create a Contract without a address and ABI`);

    if (wallet && !Utils.isEthersJsSigner(wallet))
      throw new Error(`Cannot set an invalid wallet for a Contract`);

    // If there's a wallet, connect it with provider. Otherwise use provider directly (for read operations only).
    const signerOrProvider = wallet
      ? wallet.connect(this.#provider)
      : this.#provider;

    this.#contract = new ethers.Contract(address, abi, signerOrProvider);
    this.#addFunctionsToContract();
  };

  #addFunctionsToContract = () => {
    this.#contract.interface.abi
      .filter(json => {
        return json.type === "function";
      })
      .forEach(f => {
        var isWrite =
          f.stateMutability !== "view" && f.stateMutability !== "pure";
        if (isWrite) this.#attachWriteFunction(f);
        else {
          this.#attachReadFunction(f);
        }
      });
  };

  #attachReadFunction = f => {
    this[f.name] = async (...args) => {
      const value = await this.#contract[f.name].apply(null, args);
      return value;
    };
  };

  #attachWriteFunction = f => {
    this[f.name] = (...args) => {
      if (!Utils.isEthersJsSigner(this.#contract.signer))
        throw new Error(`Cannot write data to a Contract without a wallet`);

      const tx = this.#contract[f.name].apply(null, args);
      const subscription = new TransactionSubscription(tx, this.#provider);
      return subscription;
    };
  };
}

export const TasitAction = {
  Contract,
};

export default TasitAction;
