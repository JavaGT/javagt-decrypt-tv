export function takeOptionValue(argv, index, flag) {
    const value = argv[index + 1];
    if (!value || value.startsWith('-')) {
        throw new Error(`Missing value for ${flag}`);
    }
    return value;
}

export default {
    takeOptionValue
};
