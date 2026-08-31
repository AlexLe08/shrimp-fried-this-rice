import { SlashCommandBuilder, ChannelType } from 'discord.js';
export default {
    data: new SlashCommandBuilder()
        .setName('echo')
        .setDescription('Replies with your input!')
        .addStringOption(option => option.setName('input')
        .setDescription('The input to echo back')
        // Ensure the text will fit in an embed description, if the user chooses that option
        .setMaxLength(2000)
        .setRequired(true))
        .addChannelOption((option) => {
        return option.setName('channel')
            .setDescription('The channel to send the echo in')
            // Ensure the user can only select a TextChannel for output
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true);
    })
        .addBooleanOption((option) => {
        return option.setName('ephemeral').setDescription('Whether or not the echo should be ephemeral');
    }),
};
//# sourceMappingURL=echo.js.map