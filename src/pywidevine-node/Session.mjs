import crypto from 'crypto';

export class Session {
    constructor(number) {
        this.number = number;
        this.id = crypto.randomBytes(16);
        this.serviceCertificate = null;
        this.context = new Map();
        this.keys = [];
    }
}

export default Session;
