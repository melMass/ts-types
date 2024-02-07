//TODO: type better to remove the ignores

export enum QWebChannelMessageTypes {
  Signal = 1,
  PropertyUpdate = 2,
  Init = 3,
  Idle = 4,
  Debug = 5,
  InvokeMethod = 6,
  ConnectToSignal = 7,
  DisconnectFromSignal = 8,
  SetProperty = 9,
  Response = 10,
}
interface QObjectSignal {
  connect: (callback: Function) => void;
  disconnect: (callback: Function) => void;
}
interface QObjectData {
  methods: any[];
  properties: any[];
  signals: any[];
  enums: Record<string, number>;
}
interface Transport {
  send: (data: string) => void;
  onmessage: (event: MessageEvent) => void;
}

interface QWebChannelOptions {
  send: Transport["send"];
}

export class QWebChannel {
  private readonly transport: Transport;
  private execCallbacks: Record<number, (data: any) => void> = {};
  private execId = 0;
  objects: Record<string, QObject> = {};

  constructor(
    transport: Transport,
    initCallback: (channel: QWebChannel) => void
  ) {
    if (typeof transport !== "object" || typeof transport.send !== "function") {
      console.error(
        "The QWebChannel expects a transport object with a send function."
      );
      //   return;
      throw Error(
        "The QWebChannel expects a transport object with a send function."
      );
    }

    this.transport = transport;
    this.transport.onmessage = this.handleMessage.bind(this);

    this.init(initCallback);
  }

  private init(initCallback: (channel: QWebChannel) => void): void {
    this.exec(
      { type: QWebChannelMessageTypes.Init },
      (data: Record<string, QObjectData>) => {
        Object.keys(data).forEach((objectName) => {
          const objectData = data[objectName];
          const qObject = new QObject(objectName, objectData, this);
          this.objects[objectName] = qObject;
        });

        Object.values(this.objects).forEach((object) => {
          object.unwrapProperties();
        });

        if (initCallback) {
          initCallback(this);
        }

        this.exec({ type: QWebChannelMessageTypes.Idle });
      }
    );
  }

  exec(data: any, callback?: (data: any) => void): void {
    if (!callback) {
      this.send(data);
      return;
    }

    if (this.execId === Number.MAX_VALUE) {
      this.execId = Number.MIN_VALUE;
    }

    if (data.hasOwnProperty("id")) {
      console.error(
        "Cannot exec message with property id: ",
        JSON.stringify(data)
      );
      return;
    }

    data.id = this.execId++;
    this.execCallbacks[data.id] = callback;
    this.send(data);
  }

  private send(data: any): void {
    const jsonData = typeof data !== "string" ? JSON.stringify(data) : data;
    this.transport.send(jsonData);
  }

  private handleMessage(message: MessageEvent): void {
    let data = message.data;
    if (typeof data === "string") {
      data = JSON.parse(data);
    }

    switch (data.type) {
      case QWebChannelMessageTypes.Signal:
        this.handleSignal(data);
        break;
      case QWebChannelMessageTypes.Response:
        this.handleResponse(data);
        break;
      case QWebChannelMessageTypes.PropertyUpdate:
        this.handlePropertyUpdate(data);
        break;
      default:
        console.error("Invalid message received:", message.data);
        break;
    }
  }

  private handleSignal(message: any): void {
    const object = this.objects[message.object];
    if (object) {
      object.signalEmitted(message.signal, message.args);
    } else {
      console.warn("Unhandled signal:", message.object + "::" + message.signal);
    }
  }

  private handleResponse(message: any): void {
    const callback = this.execCallbacks[message.id];
    if (callback) {
      callback(message.data);
      delete this.execCallbacks[message.id];
    } else {
      console.error("Callback not found for response id:", message.id);
    }
  }

  private handlePropertyUpdate(message: any): void {
    message.data.forEach((data: any) => {
      const object = this.objects[data.object];
      if (object) {
        object.propertyUpdate(data.signals, data.properties);
      } else {
        console.warn(
          "Unhandled property update:",
          data.object + "::" + data.signal
        );
      }
    });
    this.exec({ type: QWebChannelMessageTypes.Idle });
  }
}

interface QObjectData {
  methods: any[];
  properties: any[];
  signals: any[];
  enums: Record<string, number>;
}

class QObject {
  private readonly id: string;
  private readonly webChannel: QWebChannel;
  private objectSignals: Record<string, Function[]> = {};
  private propertyCache: Record<string, any> = {};

  constructor(id: string, data: QObjectData, webChannel: QWebChannel) {
    this.id = id;
    this.webChannel = webChannel;
    this.webChannel.objects[id] = this;

    data.methods.forEach((methodData: any) => this.addMethod(methodData));
    data.properties.forEach((propertyInfo: any) =>
      this.bindGetterSetter(propertyInfo)
    );
    data.signals.forEach((signal: any) => this.addSignal(signal, false));
    Object.assign(this, data.enums);
  }

  public unwrapProperties(): void {
    for (const propertyIndex in this.propertyCache) {
      if (this.propertyCache.hasOwnProperty(propertyIndex)) {
        this.propertyCache[propertyIndex] = this.unwrapQObject(
          this.propertyCache[propertyIndex]
        );
      }
    }
  }

  public signalEmitted(signalName: string, signalArgs: any[]): void {
    this.invokeSignalCallbacks(signalName, this.unwrapQObject(signalArgs));
  }

  public propertyUpdate(
    signals: any[],
    propertyMap: Record<string, any>
  ): void {
    for (const propertyIndex in propertyMap) {
      if (propertyMap.hasOwnProperty(propertyIndex)) {
        this.propertyCache[propertyIndex] = this.unwrapQObject(
          propertyMap[propertyIndex]
        );
      }
    }

    for (const signalName in signals) {
      if (signals.hasOwnProperty(signalName)) {
        this.invokeSignalCallbacks(signalName, signals[signalName]);
      }
    }

    this.webChannel.exec({ type: QWebChannelMessageTypes.Idle });
  }

  private addMethod(methodData: any): void {
    const methodName = methodData[0] as string;
    const methodIdx = methodData[1];
    //@ts-ignore
    this[methodName] = (..._arguments: any[]) => {
      const args = _arguments.map((arg) => {
        return typeof arg === "function"
          ? arg.name
          : arg instanceof QObject &&
            this.webChannel.objects[arg.id] !== undefined
          ? { id: arg.id }
          : arg;
      });

      return new Promise((resolve, reject) => {
        this.webChannel.exec(
          {
            type: QWebChannelMessageTypes.InvokeMethod,
            object: this.id,
            method: methodName,
            args: args,
          },
          (response: any) => {
            if (response !== undefined) {
              resolve(this.unwrapQObject(response));
            } else {
              reject();
            }
          }
        );
      });
    };
  }

  private bindGetterSetter(propertyInfo: any): void {
    const propertyIndex = propertyInfo[0];
    const propertyName = propertyInfo[1];
    const notifySignalData = propertyInfo[2];
    this.propertyCache[propertyIndex] = propertyInfo[3];

    if (notifySignalData) {
      this.addSignal(notifySignalData, true);
    }

    Object.defineProperty(this, propertyName, {
      configurable: true,
      get: () => {
        const propertyValue = this.propertyCache[propertyIndex];
        if (propertyValue === undefined) {
          console.warn(
            `Undefined value in property cache for property "${propertyName}" in object ${this.id}`
          );
        }
        return propertyValue;
      },
      set: (value: any) => {
        if (value === undefined) {
          console.warn(
            `Property setter for ${propertyName} called with undefined value!`
          );
          return;
        }
        this.propertyCache[propertyIndex] = value;
        let valueToSend = value;
        if (
          valueToSend instanceof QObject &&
          this.webChannel.objects[valueToSend.id] !== undefined
        ) {
          valueToSend = { id: valueToSend.id };
        }
        this.webChannel.exec({
          type: QWebChannelMessageTypes.SetProperty,
          object: this.id,
          property: propertyIndex,
          value: valueToSend,
        });
      },
    });
  }

  private addSignal(signalData: any, isPropertyNotifySignal: boolean): void {
    const signalName = signalData[0] as string;
    const signalIndex = signalData[1];
    //@ts-ignore
    this[signalName as any] = {
      connect: (callback: Function) => {
        if (typeof callback !== "function") {
          console.error(
            `Bad callback given to connect to signal ${signalName}`
          );
          return;
        }

        this.objectSignals[signalIndex] = this.objectSignals[signalIndex] || [];
        this.objectSignals[signalIndex].push(callback);

        if (isPropertyNotifySignal) return;

        if (
          signalName !== "destroyed" &&
          signalName !== "destroyed()" &&
          signalName !== "destroyed(QObject*)"
        ) {
          if (this.objectSignals[signalIndex].length === 1) {
            this.webChannel.exec({
              type: QWebChannelMessageTypes.ConnectToSignal,
              object: this.id,
              signal: signalIndex,
            });
          }
        }
      },
      disconnect: (callback: Function) => {
        if (typeof callback !== "function") {
          console.error(
            `Bad callback given to disconnect from signal ${signalName}`
          );
          return;
        }

        const index = this.objectSignals[signalIndex].indexOf(callback);
        if (index !== -1) {
          this.objectSignals[signalIndex].splice(index, 1);
          if (
            !isPropertyNotifySignal &&
            this.objectSignals[signalIndex].length === 0
          ) {
            this.webChannel.exec({
              type: QWebChannelMessageTypes.DisconnectFromSignal,
              object: this.id,
              signal: signalIndex,
            });
          }
        } else {
          console.error(
            `Cannot find connection of signal ${signalName} to ${callback.name}`
          );
        }
      },
    } as QObjectSignal;
  }

  private unwrapQObject(response: any): any {
    if (response instanceof Array) {
      return response.map((qobj: any) => this.unwrapQObject(qobj));
    }

    if (!(response instanceof Object)) {
      return response;
    }

    if (!response["__QObject*__"] || response.id === undefined) {
      const jsonObject: Record<string, any> = {};
      for (const propName in response) {
        if (response.hasOwnProperty(propName)) {
          jsonObject[propName] = this.unwrapQObject(response[propName]);
        }
      }
      return jsonObject;
    }

    const objectId = response.id;
    if (this.webChannel.objects[objectId]) {
      return this.webChannel.objects[objectId];
    }

    if (!response.data) {
      console.error(`Cannot unwrap unknown QObject ${objectId} without data.`);
      return;
    }

    const qObject = new QObject(objectId, response.data, this.webChannel);
    //@ts-ignore
    qObject.destroyed.connect(() => {
      if (this.webChannel.objects[objectId] === qObject) {
        delete this.webChannel.objects[objectId];
        //@ts-ignore
        Object.keys(qObject).forEach((name) => delete qObject[name]);
      }
    });
    qObject.unwrapProperties();
    return qObject;
  }

  private invokeSignalCallbacks(signalName: string, signalArgs: any[]): void {
    const connections = this.objectSignals[signalName];
    if (connections) {
      connections.forEach((callback) => {
        callback.apply(callback, signalArgs);
      });
    }
  }
}
