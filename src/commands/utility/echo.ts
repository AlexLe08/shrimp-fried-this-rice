import { SlashCommandBuilder, ChannelType, ChatInputCommandInteraction, MessageFlags } from 'discord.js';

export default {
    data: new SlashCommandBuilder()
        .setName('echo')
        .setDescription('Replies with your input!')
        .addStringOption(option =>
            option.setName('input')
                .setDescription('The input to echo back')
                // Ensure the text will fit in an embed description, if the user chooses that option
                .setMaxLength(2000)
                .setRequired(true)
        )
        .addChannelOption( (option) => {
            return option.setName('channel')
                .setDescription('The channel to send the echo in')
                // Ensure the user can only select a TextChannel for output
                .addChannelTypes(ChannelType.GuildText)
                .setRequired(true)
        })
        .addBooleanOption( (option) => {
            return option.setName('ephemeral').setDescription('Whether or not the echo should be ephemeral')
        }),
    async execute(interaction: ChatInputCommandInteraction) {
        if (!interaction.inCachedGuild()) {
            await interaction.reply({
                content: 'This command can only be used in a server.',
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

		const input = interaction.options.getString('input', true);
		const channel = interaction.options.getChannel('channel', true);
		const ephemeral = interaction.options.getBoolean('ephemeral') ?? false;

		if (!channel.isTextBased()) {
			await interaction.reply({
				content: 'Please select a text channel.',
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		await channel.send(input);

		await interaction.reply({
            content: `Echoed your message to ${channel}.`,
            ...(ephemeral ? { flags: MessageFlags.Ephemeral} : {} )
        });
	},
};